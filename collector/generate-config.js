/*
*  @TODO - https://status-v2.herokuapp.com/json
*  Generate the config
*/

const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);

const fetch = require('node-fetch');

console.log('Querying the current state of the nodes on the Orbs Network V2...');

(async function () {
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
                serviceName: `chain-${chain.Id}`
            });
        }
    }

    for (let k in networkStatus.Services) {
        let service = networkStatus.Services[k];

        for (let n in nodes) {
            let node = nodes[n];
            pods.push({
                targetUrl: `http://${node.Ip}:8666/logs/${service.ServiceUrlName}`,
                serviceName: `service-${service.Name}`
            });
        }
    }

    await writeFile(path.join(__dirname, 'config.json'), JSON.stringify(pods, null, 2));
})();