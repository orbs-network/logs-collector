const chalk = require('chalk');
const prettyBytes = require('pretty-bytes');

const stats = {
    setup(pods) {
        this.pods = pods;
        setInterval(() => {
            this.output();
        }, 5 * 1000);
    },
    output() {
        let logstashConnected;

        let totalSentBytes = 0;
        let totalUnackedBytes = 0;

        for (let n in this.pods) {
            let pod = this.pods[n];

            if (!logstashConnected) {
                logstashConnected = !pod.logstashConnectivityReported;
            }

            totalSentBytes += pod.stats.totalSentBytes;
            totalUnackedBytes += pod.stats.totalUnackedBytes;
        }

        let logstashMsg;
        if (logstashConnected) {
            logstashMsg = chalk.yellowBright('LOGSTASH OK  ');
        } else {
            logstashMsg = chalk.greenBright('LOGSTASH NOTOK  ');
        }

        let msg = chalk.white(`PODS: ${this.pods.length}   `) + logstashMsg +
            chalk.whiteBright('SENT: ') + chalk.cyanBright(prettyBytes(totalSentBytes)) + '  ' +
            chalk.whiteBright('PENDING: ') + chalk.cyan(prettyBytes(totalUnackedBytes));

        console.log(msg);
    }
};

module.exports = {
    stats,
};