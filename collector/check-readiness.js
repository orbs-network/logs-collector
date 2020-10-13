const fetch = require('node-fetch');

async function elasticAnswers() {
    try {
        const result = await fetch('http://localhost:5601/');
        if (result.status === 200) {
            return Promise.resolve(true);
        }
    } catch (e) {
        // Yeh, not ready yet
        return Promise.resolve(false);
    }
}

(async function () {
    let result;

    for (let i = 0; i < 100; i++) {
        result = await elasticAnswers();
        if (result !== true) {
            await new Promise((r) => setTimeout(r, 5000));
        } else {
            process.exit(0);
        }
    }
})();