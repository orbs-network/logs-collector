const fs = require('fs');
const path = require('path');
const configPath = path.join(__dirname, 'config.json');

const pods = [];

const { Pod } = require('./library/pod');
const { stats } = require('./library/stats');

if (fs.existsSync(configPath)) {
    try {
        const configAsString = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configAsString);

        for (let n in config) {
            let podConfig = config[n];
            const pod = new Pod(podConfig);
            pod.start();
            pods.push(pod);
        }
    } catch (e) {
        console.log('Failed to startup collector', e);
        process.exit(2);
    }
} else {
    console.log('No configuration available for the collector!');
    console.log('Please generate the config using $ node generate-config.js');
    process.exit(1);
}

// const somePod = new Pod({
//     targetUrl: 'http://docker.for.mac.host.internal:3030/logs/nn',
//     serviceName: 'nn',
// });
// somePod.start();

// pods.push(somePod);

stats.setup(pods);