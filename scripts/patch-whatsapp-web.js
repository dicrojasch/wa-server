'use strict';

const fs = require('fs');
const path = require('path');

const packageRoot = path.dirname(require.resolve('whatsapp-web.js/package.json'));
const version = require(path.join(packageRoot, 'package.json')).version;
const utilsPath = path.join(packageRoot, 'src', 'util', 'Injected', 'Utils.js');
const source = fs.readFileSync(utilsPath, 'utf8');
const fix = '        delete message.__x_id;';

if (source.includes(fix)) {
    console.log('whatsapp-web.js media fix is already present.');
    process.exit(0);
}

if (version !== '1.34.7') {
    throw new Error(`Review the media patch before applying it to whatsapp-web.js ${version}.`);
}

const anchor = "        };\n\n        // Bot's won't reply if canonicalUrl is set (linking)";
if (source.split(anchor).length !== 2) {
    throw new Error('Could not locate the outgoing message in whatsapp-web.js Utils.js.');
}

fs.writeFileSync(utilsPath, source.replace(anchor, `        };\n\n${fix}\n\n        // Bot's won't reply if canonicalUrl is set (linking)`));
console.log('Applied whatsapp-web.js media ID fix.');
