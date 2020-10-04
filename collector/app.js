/*

    1. Find the peers in the network
    2. Discover which services I should pull the network for logs
    3. Once having that list -> Create pullers including state files for them in case of crashes.

*/

const { Pod } = require('./library/pod');

const somePod = new Pod({
    targetUrl: 'http://127.0.0.1:3030/logs/nn',
    serviceName: 'nn',
});
somePod.start();