const { Pod } = require('./library/pod');
const { stats } = require('./library/stats');
const { getConfiguration, detectConfigChanges } = require('./library/config');

const reconfigIntervalInMilli = 86400 * 1000;
const pods = [];
let config;

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