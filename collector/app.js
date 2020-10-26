const { Pod } = require('./library/pod');
const { stats } = require('./library/stats');
const { getConfiguration, mergeConfigs } = require('./library/config');

const reconfigIntervalInMilli = 86400 * 1000;
const pods = [];
let config;

async function continuousSetup() {
    console.log('Configuring pods...');
    if (!config) {
        console.log('initial run');
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
        config = mergeConfigs({
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

continuousSetup();
setInterval(() => { continuousSetup(); }, reconfigIntervalInMilli);

// process.on('unhandledRejection', () => {
//     // For now we just want unhandled rejections to not output to console.
// });

process.on('uncaughtException', () => {
    // For now we just want uncaught exceptions to not output to console.
});