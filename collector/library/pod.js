const path = require('path');
const events = require('events');
const fs = require('fs');
const util = require('util');

const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const chalk = require('chalk');
const { sortBy } = require('lodash');

const { BATCH, UNACKED_DATA } = require('./constants');
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

/**
 * @todo:
 * 
 * 
 * 3. Thesis testing: Make sure that access to Logstash is handled by simply re-trying at a later point in time
 *    without creating timers for each and every packet of data.
 * 
 *    As in, if the first packet sending to Logstash fails, abort the entire process and wait for the next
 *    file checker iteration in order to send the data out.
 * 
 *    Leave the mechanism for re-trying packets aside for now (let's see if this improves memory performance somehow)
 * 
 * 5. Persistent mechanism & Startup review together with Ron
 * 6. Reconfigure live while the process is running
 * 7. Change the implementation of submitDataToLogstash to use the new endpoints from logs-service (block based response)
 *    (start-offset)
 * 
 * 
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
        this.checkIntervalInMilli = checkInterval;
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
        console.log(`[START] periodical check for new files`, this.targetUrl);

        let result, response;

        try {
            result = await fetch(this.targetUrl);
            response = await result.json();
        } catch (err) {
            //console.log('failed getting available batches', err);
            return;
        }

        if ('status' in response && response.status === 'error') {
            //console.log('found error when fetching availble batches', response);
            return;
        }

        const batches = sortBy(response, ['id']);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const bytesSentFromBatch = await this.getBytesSentFromThisParticularBatch({ batch });

            if (bytesSentFromBatch > batch.batchSize) {
                console.log('We collected more bytes than availble!', this.targetUrl, 'batch id:', batch.id, 'bytes handled:', bytesSentFromBatch, 'batch size:', batch.batchSize);
                continue;
            }

            if (batch.batchSize > bytesSentFromBatch) {
                console.log('downloading batch', batch);
                // handle batch
                await this.handleBatch(batch);

                if (await this.getBytesSentFromThisParticularBatch({ batch }) < batch.batchSize) {
                    console.log('could not download the entire batch', batch);
                    return;
                } // Avoid moving to next batch in case we could not download the entire batch
            }
        }
    }

    stop() {
        console.log(`Shutting down pod for endpoint ${this.targetUrl}`);
        clearInterval(this.pid);
    }

    /**
     * The start() method is responsible for the liveliness of the Pod
     * it has a timer function which runs every X amount of seconds and checks for new files
     * if it finds new files it fires event calls to update the system for these new available batch files for this specific Pod.
     *
     */
    async start() {
        await new Promise((r) => setTimeout(r, (Math.floor(Math.random() * 30 * 1000))));
        await this.createWorkDir();

        let counter = 1;

        const setupTimer = () => {
            this.checkForNewFiles()
                .finally(() => {
                    this.pid = setTimeout(setupTimer, this.checkIntervalInMilli);
                });
        };

        setupTimer();
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

    async handleBatch(batch) {
        console.log(`${chalk.greenBright('[NEW BATCH]')} (id: ${batch.id})`);

        const request = await fetch(`${this.targetUrl}/batch/${batch.id}?follow`);

        const bytesAlreadySentToLogstashFromThisBatch = await this.getBytesSentFromThisParticularBatch({ batch });
        let bytesSentAccumlator = 0;

        if (!request.ok) {
            throw new Error('The request did not finish successfully!');
        }

        await new Promise((res, rej) => {
            request.body.on('data', async (data) => {
                let sendData = false;
                if (bytesAlreadySentToLogstashFromThisBatch > 0 && bytesSentAccumlator >= bytesAlreadySentToLogstashFromThisBatch) {
                    sendData = true;
                }

                if (bytesAlreadySentToLogstashFromThisBatch === 0) {
                    sendData = true;
                }

                if (sendData) {
                    await this.submitDataToLogstash({ data, batch }).catch((err) => {
                        rej(err);
                        request.body.destroy();
                    });
                }

                bytesSentAccumlator += data.length;
            });

            request.body.on('error', (err) => {
                console.log(err);
            });
            request.body.on('end', res); // @todo: print a log line here to understand if we closed the connection on error
        });
    }

    /**
     * As we are using an events emitter, this is the backbone of our collector application
     * this method includes all the handlers for the various events we have in the system / per Pod of course.
     */
    registerHandlers() {
        //this.em.on(BATCH, 

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
    async submitDataToLogstash({ data, batch, }) {
        const body = JSON.stringify({ message: data.toString() });

        await fetch('http://logstash:5000/', {
            method: 'post',
            body,
            headers: { 'Content-Type': 'application/json' },
        });

        await this.documentSentData({ data, batch });
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