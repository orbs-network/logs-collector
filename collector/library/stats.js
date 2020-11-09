const chalk = require('chalk');
const prettyBytes = require('pretty-bytes');

let lastSentBytes = 0;

const stats = {
    setup(pods) {
        this.pods = pods;
        setInterval(() => {
            this.output();
        }, 10 * 1000);
    },
    output() {
        let logstashConnected = false;

        let totalSentBytes = 0;

        for (let n in this.pods) {
            let pod = this.pods[n];

            totalSentBytes += pod.stats.totalSentBytes;
        }

        if (totalSentBytes > lastSentBytes){
            logstashConnected = true;
        }

        let logstashMsg;
        if (logstashConnected) {
            logstashMsg = chalk.greenBright('LOGSTASH OK  ');
        } else {
            logstashMsg = chalk.yellowBright('LOGSTASH NOTOK  ');
        }

        lastSentBytes = totalSentBytes;

        let msg = chalk.white(`Pods: ${this.pods.filter(pod => pod.state === 'active').length}/${this.pods.length}   `) + logstashMsg +
            chalk.whiteBright('Sent: ') + chalk.cyanBright(prettyBytes(totalSentBytes));

        console.log(msg);
    }
};

module.exports = {
    stats,
};