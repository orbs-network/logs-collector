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
 * 
 * @todo
 * 
 * - It might take Logstash a minute or so to initialize, need to try and buffer data packets which encountered an error getting
 *    to Kibana and re-send them when the connection is open.
 * - Create script that initializes everything and opens up Kibana on the default browser.
 * - Setup the persisted queue
 * - Update the README
 * - Add meaningful logs on the collector operations and remove old debugging logs.
 */

class Pod {
    constructor({
        targetUrl,
        serviceName,
        startDelay = 24,
        checkInterval = 30 * 1000,
        workspacePath = path.join(__dirname, '../workspace/'),
    }) {
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

    createWorkDir() {
        return mkdir(path.join(this.workspacePath, this.serviceName), { recursive: true });
    }

    async start() {
        await this.createWorkDir();

        // Create all handlers
        const checkForNewFiles = async () => {
            console.log('[START] periodical check for new files');
            const result = await fetch(this.targetUrl);
            const response = await result.json();

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
        };

        this.registerHandlers();

        setTimeout(() => {
            checkForNewFiles();
            this.pid = setInterval(checkForNewFiles, this.checkInterval);
        }, this.startDelay);
    }

    getTargetPathForBatch({ batch }) {
        return path.join(this.workspacePath, this.serviceName, `batch-${batch.id}`);
    }

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

    registerHandlers() {
        this.em.on(BATCH, async (batch) => {
            console.log(`${chalk.greenBright('[NEW BATCH]')} (id: ${batch.id})`);
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
        });

        this.em.on(UNACKED_DATA, async ({ data, packetId }) => {
            await this.submitDataToLogstash({ data, packetId });
        });
    }

    async submitDataToLogstash({ data, batch, packetId = '' }) {
        const body = JSON.stringify({ message: data.toString() });

        try {
            await fetch('http://logstash:5000/', {
                method: 'post',
                body,
                headers: { 'Content-Type': 'application/json' },
            });

            if (this.logstashConnectivityReported) {
                console.log(chalk.greenBright('Reconnected to logstash'));
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
                console.log(chalk.yellow('connection to logstash refused, keeping quite for now'), e);
                this.logstashConnectivityReported = true;
            }
        }

        return Promise.resolve();
    }

    async documentSentData({ data, batch }) {
        this.accumulator[batch.id] += data.length;
        this.stats.totalSentBytes += data.length;
        await writeFile(this.getTargetPathForBatch({ batch }), this.accumulator[batch.id].toString());
    }
}

module.exports = {
    Pod
};