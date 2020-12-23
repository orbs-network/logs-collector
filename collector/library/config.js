/*
*  @TODO - https://status-v2.herokuapp.com/json
*  Generate the config
*/

const fetch = require('node-fetch');

async function getConfiguration() {
    console.log('Querying the current state of the nodes on the Orbs Network V2...');
    const response = await fetch('https://status-v2.herokuapp.com/json');
    const networkStatus = await response.json();

    const nodes = { ...networkStatus.CommitteeNodes, ...networkStatus.StandByNodes };
    const pods = [];

    for (let k in networkStatus.VirtualChains) {
        let chain = networkStatus.VirtualChains[k];

        for (let n in nodes) {
            let node = nodes[n];

            pods.push({
                targetUrl: `http://${node.Ip}:8666/logs/chain-${chain.Id}`,
                serviceName: `chain-${chain.Id}`,
                ip: node.Ip,
            });
        }
    }

    for (let k in networkStatus.Services) {
        let service = networkStatus.Services[k];

        for (let n in nodes) {
            let node = nodes[n];

            pods.push({
                targetUrl: `http://${node.Ip}:8666/logs/${service.ServiceUrlName}`,
                serviceName: `${service.Name}`,
                ip: node.Ip,
            });
        }
    }

    return pods;
}

function detectConfigChanges({ oldConfig, newConfig, removeCallback, addCallback }) {
    const mergedConfig = [];

    for (let n in newConfig) {
        const podConfig = newConfig[n];
        if (oldConfig.findIndex(c => c.targetUrl === podConfig.targetUrl) === -1) {
            // This is a new endpoint to monitor
            addCallback(podConfig);
        }
        mergedConfig.push(podConfig);
    }

    for (let n in oldConfig) {
        const podConfig = oldConfig[n];
        if (newConfig.findIndex(c => c.targetUrl === podConfig.targetUrl) === -1) {
            // This is a pod that we do not need to monitor anymore.
            removeCallback(podConfig);
        }
    }

    return newConfig;
}

module.exports = {
    getConfiguration,
    detectConfigChanges,
};

