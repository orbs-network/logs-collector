const { describe, it } = require('mocha');
const { expect } = require('chai');
const { getConfiguration, detectConfigChanges } = require('./../library/config');

let baseConfig;

describe('live config tests', () => {
    before('set base config once', async () => {
        baseConfig = await getConfiguration();
    });

    it('should provide a base configuration', async () => {
        const config = [].concat(baseConfig);
        expect(config).to.be.an('array');
        expect(config.length).to.be.greaterThan(0);
        expect(config[0]).to.have.keys(['targetUrl', 'serviceName']);
    });

    it('should be able to merge the config and provide the same exact config (no changes)', async () => {
        const oldConfig = [].concat(baseConfig);
        const newConfig = [].concat(oldConfig);
        let addCalled = false;
        let removeCalled = false;

        const config = detectConfigChanges({
            oldConfig,
            newConfig,
            addCallback: () => {
                addCalled = true;
            },
            removeCallback: () => {
                removeCalled = true;
            }
        });

        expect(config).to.eql(oldConfig);
        expect(config).to.eql(newConfig);
        expect(addCalled).to.equal(false);
        expect(removeCalled).to.equal(false);
    });

    it('should merge configs and add 1 new endpoint', async () => {
        const addedEndpoints = [{
            targetUrl: 'http://someendpoint.com/logs/blabla',
            serviceName: 'some-new-service',
        }];

        let addCalled = false;
        let removeCalled = false;

        const oldConfig = [].concat(baseConfig);
        const newConfig = [].concat(oldConfig, addedEndpoints);

        const adds = [];

        const config = detectConfigChanges({
            oldConfig,
            newConfig,
            addCallback: (o) => {
                adds.push(o);
                addCalled = true;
            },
            removeCallback: () => {
                removeCalled = true;
            }
        });

        expect(addCalled).to.equal(true);
        expect(adds).to.eql(addedEndpoints);
        expect(removeCalled).to.equal(false);
        expect(config.length).to.equal(oldConfig.length + 1);
        expect(config.findIndex(ep => ep.targetUrl === addedEndpoints[0].targetUrl) !== -1).to.equal(true);
    });

    it('should merge configs and removed 1 existing endpoint', async () => {
        let addCalled = false;
        let removeCalled = false;

        const oldConfig = [].concat(baseConfig);
        const newConfig = [].concat(oldConfig);
        const removedEndpoint = newConfig.splice(0, 1);
        const removals = [];

        const config = detectConfigChanges({
            oldConfig,
            newConfig,
            addCallback: () => {
                addCalled = true;
            },
            removeCallback: (o) => {
                removals.push(o);
                removeCalled = true;
            }
        });

        expect(addCalled).to.equal(false);
        expect(removals).to.eql(removedEndpoint);
        expect(removeCalled).to.equal(true);
        expect(config.length).to.equal(oldConfig.length - 1);
        expect(config.findIndex(ep => ep.targetUrl === removedEndpoint[0].targetUrl) === -1).to.equal(true);
    });
});