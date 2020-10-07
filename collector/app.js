/*

    1. Find the peers in the network
    2. Discover which services I should pull the network for logs
    3. Once having that list -> Create pullers including state files for them in case of crashes.

*/

const pods = [];

const { Pod } = require('./library/pod');
const { stats } = require('./library/stats');

const somePod = new Pod({
    targetUrl: 'http://docker.for.mac.host.internal:3030/logs/nn',
    serviceName: 'nn',
});
somePod.start();

pods.push(somePod);

stats.setup(pods);