const path = require('path');
const events = require('events');
const fs = require('fs');
const util = require('util');

const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const chalk = require('chalk');
const { sortBy, isObject } = require('lodash');

const { BATCH, UNACKED_DATA } = require('./constants');
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

/**
 * @todo:
 * 
 * 1. Make sure we only have 1 timer that runs the periodical files checker
 *    This new timer, will be responsible to iterate through the local file checker methods and run them one by one
 *    to avoid CPU spikes.
 * 
 * 2. (timer work): In case after one run, the Pod is determined as 'disabled', filter it from future runs
 * 3. Thesis testing: Make sure that access to Logstash is handled by simply re-trying at a later point in time
 *    without creating timers for each and every packet of data. 
 * 
 *    As in, if the first packet sending to Logstash fails, abort the entire process and wait for the next
 *    file checker iteration in order to send the data out.
 * 
 *    Leave the mechanism for re-trying packets aside for now (let's see if this improves memory performance somehow)
 * 
 */

class Pod {
    constructor({
        targetUrl,
        serviceName,
        startDelay = 24,
        checkInterval = 30 * 1000,
        workspacePath = path.join(__dirname, '../workspace/'),
    }) {
        this.state = 'active';
        this.accumulator = [];
        this.pid = null;
        this.em = new events.EventEmitter();

        this.serviceName = serviceName;
        this.targetUrl = targetUrl;
        this.checkInterval = checkInterval;
        this.startDelay = startDelay;
        this.workspacePath = workspacePath;
        this.seenBatches = [];
        this.unackedPackets = [];
        this.stats = {
            totalSentBytes: 0,
            totalUnackedBytes: 0,
        };
    }

    /**
     * This runs only once per pod instance and makes sure the working directory (the root one for our Pod) has been created so that we can
     * later on update our state based on this path.
     */
    createWorkDir() {
        return mkdir(path.join(this.workspacePath, this.serviceName), { recursive: true });
    }

    async checkForNewFiles() {
        console.log(`[START][${this.state}] periodical check for new files`);
        if (this.state === 'disabled') {
            return;
        }

        let result, response;

        try {
            result = await fetch(this.targetUrl);
            response = await result.json();
        } catch (err) {
            if (err.message.indexOf('ECONNREFUSED') !== -1) {
                console.log('clearly no logs here: ', this.targetUrl);
                console.log('shutting this pod off for now..');
                this.state = 'disabled';
                return;
            }
        }

        if ('status' in response && response.status === 'error') {
            console.log('clearly no logs here: ', this.targetUrl);
            console.log('shutting this pod off for now..');
            this.state = 'disabled';
            return;
        }

        const batches = sortBy(response, ['id']);

        for (let i = 0; i < batches.length; i++) {
            let batch = batches[i];
            let findResult = this.seenBatches.findIndex(b => b.id === batch.id);
            if (findResult === -1) {
                this.seenBatches.push(batch);
                this.em.emit(BATCH, batch);
            } else {
                // Make sure that the batches that you've already seen have not changed in their length
                // incase we have history for them on our file system

                let bytesGotFromBatch = await this.getBytesSentFromThisParticularBatch({ batch });
                // Incase we get disconnected for some reason (network failure or what not)
                // Let's make sure that while we do still see this batch we make sure we have heard everything it has to say.
                if (batch.batchSize > bytesGotFromBatch && this.unackedPackets.length === 0) {
                    this.em.emit(BATCH, batch);
                }
            }
        }
    }

    /**
     * The start() method is responsible for the liveliness of the Pod
     * it has a timer function which runs every X amount of seconds and checks for new files
     * if it finds new files it fires event calls to update the system for these new available batch files for this specific Pod.
     *
     */
    async start() {
        await this.createWorkDir();

        this.registerHandlers();

        setTimeout(() => {
            this.checkForNewFiles();
        }, this.startDelay);

        this.pid = setInterval(() => {
            this.checkForNewFiles();
        }, this.checkInterval);
    }

    /*
    * For each batch we have a specific file in which we update the amount of bytes submitted to Logstash
    */
    getTargetPathForBatch({ batch }) {
        return path.join(this.workspacePath, this.serviceName, `batch-${batch.id}`);
    }

    // Get the size of the batch (as in bytes size)
    async getBytesSentFromThisParticularBatch({ batch }) {
        let size;
        try {
            size = parseInt(await readFile(this.getTargetPathForBatch({ batch }), 'utf-8'));
        } catch (err) {
            size = 0;
        }

        if (!this.accumulator[batch.id]) {
            this.accumulator[batch.id] = size;
        }
        return this.accumulator[batch.id];
    }

    /**
     * As we are using an events emitter, this is the backbone of our collector application
     * this method includes all the handlers for the various events we have in the system / per Pod of course.
     */
    registerHandlers() {
        this.em.on(BATCH, async (batch) => {
            console.log(`${chalk.greenBright('[NEW BATCH]')} (id: ${batch.id})`);
            try {
                const request = await fetch(`${this.targetUrl}/batch/${batch.id}?follow`);
                const bytesAlreadySentToLogstashFromThisBatch = await this.getBytesSentFromThisParticularBatch({ batch });
                let bytesSentAccumlator = 0;

                request.body.on('data', async (data) => {
                    let sendData = false;
                    if (bytesAlreadySentToLogstashFromThisBatch > 0 && bytesSentAccumlator >= bytesAlreadySentToLogstashFromThisBatch) {
                        sendData = true;
                    }

                    if (bytesAlreadySentToLogstashFromThisBatch === 0) {
                        sendData = true;
                    }

                    if (sendData) {
                        await this.submitDataToLogstash({ data, batch });
                    }

                    bytesSentAccumlator += data.length;
                });

            } catch (err) {
                // The request got an error for some reason,
                // The next round for new files scouting will pick up where we left off ;-)
            }
        });

        this.em.on(UNACKED_DATA, async ({ data, batch, packetId }) => {
            await this.submitDataToLogstash({ data, batch, packetId });
        });
    }

    /**
     * Submit the data to logstash once it is ready to accept data
     * This method is equipped with a mechanism to re-try logstash incase it is not ready to accept connections / is overwhelmed with
     * incoming connections from other Pods. 
     * 
     * Once the function received a correct response from Logstash, the data transmitted will be documented and inserted into the stats.
     *  
     * The method expects to receive the data buffer, a batch object including the batch Id and some other basic information regarding the current batch
     * this piece of data belongs to, and optionally a packetId identifier which is only there incase we have re-tried this data packet before and didn't succeed
     * in sending it to Lodash at the first attempt.
     * 
     */
    async submitDataToLogstash({ data, batch, packetId = '' }) {
        const body = JSON.stringify({ message: data.toString() });

        try {
            await fetch('http://logstash:5000/', {
                method: 'post',
                body,
                headers: { 'Content-Type': 'application/json' },
            });

            if (this.logstashConnectivityReported) {
                this.logstashConnectivityReported = false;
            }

            if (packetId.length > 0) {
                // This packet has been sent successfully now, let's remove it from the unacked packets array
                let packetIndex = this.unackedPackets.findIndex(o => o.packetId === packetId);
                if (packetIndex !== -1) {
                    this.stats.totalUnackedBytes -= this.unackedPackets[packetIndex].size;
                    this.unackedPackets.splice(packetIndex, 1);
                }
            }

            await this.documentSentData({ data, batch });
        } catch (e) {
            let targetPacketId;

            if (packetId.length > 0) {
                targetPacketId = packetId;
            } else {
                // In case we couldn't send the data to Logstash let's re-try this packet again in 5 seconds
                targetPacketId = uuidv4(); // Give this packet a name
                this.unackedPackets.push({ packetId: targetPacketId, size: data.length });
                this.stats.totalUnackedBytes += data.length;
            }

            setTimeout(() => {
                this.em.emit(UNACKED_DATA, { data, batch, packetId: targetPacketId });
            }, 5 * 1000);

            if (!this.logstashConnectivityReported) {
                this.logstashConnectivityReported = true;
            }
        }

        return Promise.resolve();
    }

    /**
     * This method is used to report statistics and to update the disc-written state of
     * the batch (in cases where the connection might closed or in a crash) this way we can avoid
     * sending the same block of data from a specific batch twice.
     */
    async documentSentData({ data, batch }) {
        this.accumulator[batch.id] += data.length;
        this.stats.totalSentBytes += data.length;
        await writeFile(this.getTargetPathForBatch({ batch }), this.accumulator[batch.id].toString());
    }
}

module.exports = {
    Pod
};