const path = require('path');
const events = require('events');
const fs = require('fs');
const util = require('util');

const fetch = require('node-fetch');
const chalk = require('chalk');
const { sortBy, maxBy, trim } = require('lodash');

const DEAD_POD = 'podIsDead';
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

class Pod {
    constructor({
        targetUrl,
        serviceName,
        retryIntervalInMs = 60 * 1000,
        workspacePath = path.join(__dirname, '../workspace/'),
    }) {
        this.dead = false;
        this.state = 'active';
        this.remainder = '';

        this.accumulator = [];
        this.pid = null;
        this.em = new events.EventEmitter();

        this.serviceName = serviceName;
        this.targetUrl = targetUrl;
        this.retryIntervalInMs = retryIntervalInMs;
        this.workspacePath = workspacePath;
        this.seenBatches = [];
        this.stats = {
            totalSentBytes: 0,
        };
    }

    /**
     * This runs only once per pod instance and makes sure the working directory (the root one for our Pod) has been created so that we can
     * later on update our state based on this path.
     */
    createWorkDir() {
        return mkdir(path.join(this.workspacePath, `${this.getDirectorySafeIPFromTargetUrl(this.targetUrl)}_${this.serviceName}`), { recursive: true });
    }

    async checkAndProcessNewBatches() {
        while (true) {
            if (this.dead === true) {
                throw new Error(`Pod for ${this.targetUrl} is now dead`);
            }

            console.log(`[Check & process new batches]`, this.targetUrl);

            const result = await fetch(this.targetUrl);
            const response = await result.json();

            if ('status' in response && response.status === 'error') {
                throw new Error(`Pod for ${this.targetUrl} appears to have an error ${JSON.stringify(response)}`);
            }

            let targetBatch = maxBy(batches, 'id');
            const batches = sortBy(response, ['id']);

            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                const bytesSentFromBatch = await this.getBytesSentFromThisParticularBatch({ batch });

                if (bytesSentFromBatch > batch.batchSize) {
                    const errorMsg = `We collected more bytes than availble! ${this.targetUrl}, batch.id: ${batch.id}, bytes handled: ${bytesSentFromBatch}, batch.size: ${batch.batchSize}`;
                    console.log(errorMsg);
                    throw new Error(errorMsg);
                }

                if (batch.batchSize > bytesSentFromBatch) {
                    targetBatch = batch;
                    break;
                }
            }

            if (!targetBatch) {
                // For the rare occasion where no batches are available
                throw new Error(`No batches available to process for Pod: ${this.targetUrl}`);
            }

            // handle batch
            console.log('downloading batch', targetBatch);
            await this.handleBatch(targetBatch);
        }
    }

    stop() {
        console.log(`Shutting down pod for endpoint ${this.targetUrl}`);
        this.dead = true;
        clearInterval(this.pid);
        this.em.emit(DEAD_POD, null);
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

        const setupTimer = () => {
            this.checkAndProcessNewBatches()
                .catch((_) => {
                    // Do nothing
                })
                .finally(() => {
                    if (!this.dead) {
                        this.pid = setTimeout(setupTimer, this.retryIntervalInMs);
                    }
                });
        };

        setupTimer();
    }

    getDirectorySafeIPFromTargetUrl(a) {
        let b = a.replace('http://', '');
        return b.substr(0, b.indexOf(':')).replace(/\./g, '_');
    }

    /*
    * For each batch we have a specific file in which we update the amount of bytes submitted to Logstash
    */
    getTargetPathForBatch({ batch }) {
        return path.join(this.workspacePath, `${this.getDirectorySafeIPFromTargetUrl(this.targetUrl)}_${this.serviceName}`, `batch-${batch.id}`);
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
            this.em.on(DEAD_POD, () => {
                rej(err);
                request.body.destroy();
            });

            request.body.on('data', async (data) => {
                request.body.pause();
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
                request.body.resume();
            });

            request.body.on('error', (err) => {
                console.log(err);
            });
            request.body.on('end', res); // @todo: print a log line here to understand if we closed the connection on error
        });
    }

    jsonify(s, b) {
        let o;

        try {
            o = JSON.parse(s);
        } catch (e) {
            o = {
                textMessage: s,
            };
        }

        o._collector_batchId = b.id;
        o._collector_source_url = this.targetUrl;

        return o;
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
        const dataAsString = data.toString();
        let lines;

        lines = (this.remainder + dataAsString).split('\n');
        this.remainder = '';

        // Run on all lines but the last one!
        for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            const body = JSON.stringify(this.jsonify(trim(line), batch));

            await fetch('http://logstash:5000/', {
                method: 'post',
                body,
                headers: { 'Content-Type': 'application/json' },
            });

            // Document the amount of bytes sent (+1 for the newline)
            await this.documentSentData({ data: Buffer.from(line, 'utf-8') + 1, batch });
        }

        // Always insert the last line into the remainder for the next packet of data.
        this.remainder = lines[lines.length - 1];
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