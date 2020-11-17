const express = require('express');
const app = express();
const { promisify } = require('util');
const { exec } = require('child_process');
const { trim } = require('lodash');

const { Pod } = require('./library/pod');
const { stats } = require('./library/stats');
const { getConfiguration, detectConfigChanges } = require('./library/config');

const reconfigIntervalInMilli = 86400 * 1000;
const pods = [];
let config;

app.get('/healthcheck', async (req, res) => {
    const reply = {
        ok: false,
    };

    try {
        const result = await promisify(exec)('docker ps --format="{{ json . }}"');

        const containersJsons = result.stdout.split('\n');
        const containers = containersJsons.map((s) => {
            try {
                return JSON.parse(s);
            } catch (e) {
                return null;
            }
        }).filter(o => o !== null);

        reply.containers = containers.length;

        if (containers.length !== 4) {
            res.status(404);
            reply.ok = false;
        }

        reply.services = [
            {
                name: 'elastic-search',
                ok: (containers.find(o => o.Names === 'logs-collector_elasticsearch_1') !== undefined) ? true : false
            },
            {
                name: 'logstash',
                ok: (containers.find(o => o.Names === 'logs-collector_logstash_1') !== undefined) ? true : false
            },
            {
                name: 'kibana',
                ok: (containers.find(o => o.Names === 'logs-collector_kibana_1') !== undefined) ? true : false
            }
        ];

    } catch (err) {
        console.log(err);
        reply.containers = 0;
        reply.err = err;
    }

    res.json(reply).end();
});

app.listen(3000, () => {
    console.log('Collector health check is live and listening on port 3000');
});

async function syncNetworkConfig() {
    console.log('syncing network configuration...')
    if (!config) {
        // Initial run
        config = await getConfiguration();

        for (let n in config) {
            let podConfig = config[n];
            const pod = new Pod(podConfig);
            pod.start();
            pods.push(pod);
        }

        stats.setup(pods);
    } else {
        console.log('subsequent run');
        // Subsequent runs
        let newConfig = await getConfiguration();
        config = detectConfigChanges({
            oldConfig: config,
            newConfig,
            removeCallback: (podConfig) => {
                const idx = pods.findIndex(o => o.targetUrl === podConfig.targetUrl);
                pods[idx].stop();
                pods.splice(idx, 1);
            },
            addCallback: () => {
                const pod = new Pod(podConfig);
                pod.start();
                pods.push(pod);
            }
        });
    }
}

syncNetworkConfig();
setInterval(() => { syncNetworkConfig(); }, reconfigIntervalInMilli);

// process.on('unhandledRejection', () => {
//     // For now we just want unhandled rejections to not output to console.
// });

process.on('uncaughtException', () => {
    // For now we just want uncaught exceptions to not output to console.
});