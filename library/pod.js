const path = require('path');
const events = require('events');
const fs = require('fs');
const util = require('util');

const fetch = require('node-fetch');
const chalk = require('chalk');
const { sortBy } = require('lodash');

const { BATCH } = require('./constants');
const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const fileExist = util.promisify(fs.exists);

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

            console.log(`bytes from batch (${batch.id}) ${bytesAlreadySentToLogstashFromThisBatch}`);

            request.body.on('data', async (data) => {
                console.log('bytes received accumulated: ', batch.id, bytesSentAccumlator);
                let sendData = false;
                if (bytesAlreadySentToLogstashFromThisBatch > 0 && bytesSentAccumlator >= bytesAlreadySentToLogstashFromThisBatch) {
                    sendData = true;
                }

                if (bytesAlreadySentToLogstashFromThisBatch === 0) {
                    sendData = true;
                }

                if (sendData) {
                    console.log('bytes sent to logstash');
                    await this.submitDataToLogstash(data);
                    await this.documentSentData({ data, batch });
                }

                bytesSentAccumlator += data.length;
            });

            request.body.on('end', () => {
                console.log('request ended');
            });
        });
    }

    async submitDataToLogstash(data) {
        const body = JSON.stringify({ message: data.toString() });

        try {
            const result = await fetch('http://127.0.0.1:5000', {
                method: 'post',
                body,
                headers: { 'Content-Type': 'application/json' },
            });

            const text = await result.text();
            console.log(text);

            if (this.logstashConnectivityReported) {
                this.logstashConnectivityReported = false;
            }
        } catch (e) {
            if (!this.logstashConnectivityReported) {
                console.log('connection to logstash refused, keeping quite for now', e);
                this.logstashConnectivityReported = true;
            }
        }

        return Promise.resolve('fadksjhfak');
    }

    async documentSentData({ data, batch }) {
        this.accumulator[batch.id] += data.length;
        await writeFile(this.getTargetPathForBatch({ batch }), this.accumulator[batch.id].toString());
    }
}

module.exports = {
    Pod
};