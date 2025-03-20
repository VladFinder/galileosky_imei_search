const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

async function getAccessToken() {
    const response = await axios.post('https://auth.galileosky.com/realms/GS/protocol/openid-connect/token', new URLSearchParams({
        client_id: 'ng-frontend',
        client_secret: 'QBwTDzCOK7I3NT5HH7osQw7gv2L29Ol4',
        grant_type: 'password',
        username: config.username,
        password: config.password
    }));

    return response.data.access_token;
}

async function fetchDeviceData(imei, token) {
    try {
        const response = await axios.get('https://ca.galileosky.com/support/devices/search', {
            params: { query: imei, offset: 0, limit: 20 },
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0];
        } else {
            throw new Error('Нет данных');
        }
    } catch (error) {
        return {
            imei,
            error: error.message || 'Ошибка при получении данных'
        };
    }
}

async function processImeis() {
    if (!fs.existsSync(config.outputDir)) {
        fs.mkdirSync(config.outputDir);
    }

    const imeis = fs.readFileSync(config.imeiFile, 'utf8').trim().split('\n').map(i => i.trim()).filter(i => i);
    const token = await getAccessToken();

    const errorList = [];
    const allResults = [];
    let currentChunk = 1;

    const startTime = new Date();

    for (let i = 0; i < imeis.length; i++) {
        const imei = imeis[i];
        console.log(`(${i + 1}/${imeis.length}) Обработка IMEI: ${imei}`);

        const data = await fetchDeviceData(imei, token);

        if (data.error) {
            console.log(`Ошибка для IMEI ${imei}: ${data.error}\n`);
            errorList.push({ imei, error: data.error });

            // Заполняем все поля пустыми, кроме IMEI и ошибки
            allResults.push({
                imei,
                name: '',
                customerName: '',
                marketingName: '',
                softVersion: '',
                hasInvite: '',
                elScriptStatusCode: '',
                onStatusCode: '',
                onStatusName: '',
                updateStatusCode: '',
                error: data.error
            });
        } else {
            console.log(`Данные по IMEI ${imei} получены.\n`);
            allResults.push({ ...data, error: '' });
        }

        if ((i + 1) % config.chunkSize === 0 || i === imeis.length - 1) {
            await saveChunkFile(currentChunk, allResults);
            allResults.length = 0;
            currentChunk++;
        }
    }

    await combineChunks(currentChunk - 1);

    if (errorList.length > 0) {
        saveErrors(errorList);
    }

    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const minutes = Math.floor(duration / 60);
    const seconds = (duration % 60).toFixed(2);

    console.log(`Обработка завершена за ${minutes} мин. ${seconds} сек.\n`);
}

function saveErrors(errors) {
    const errorFile = path.join(config.outputDir, 'errors.csv');

    const csvWriter = createObjectCsvWriter({
        path: errorFile,
        header: [
            { id: 'imei', title: 'IMEI' },
            { id: 'error', title: 'Ошибка' }
        ]
    });

    csvWriter.writeRecords(errors)
        .then(() => console.log('Ошибочные IMEI сохранены в errors.csv\n'));
}

async function saveChunkFile(chunkNumber, data) {
    const filePath = path.join(config.outputDir, `chunk_${chunkNumber}.csv`);
    const headers = [
        'imei', 'name', 'customerName', 'marketingName', 'softVersion',
        'hasInvite', 'elScriptStatusCode', 'onStatusCode', 'onStatusName', 'updateStatusCode', 'error'
    ];

    const csvWriter = createObjectCsvWriter({
        path: filePath,
        header: headers.map(h => ({ id: h, title: h }))
    });

    await csvWriter.writeRecords(data);
    console.log(`Сохранен chunk-файл: ${filePath}\n`);
}

async function combineChunks(chunkCount) {
    const combinedFile = path.join(config.outputDir, 'final_result.csv');
    const headers = [
        'imei', 'name', 'customerName', 'marketingName', 'softVersion',
        'hasInvite', 'elScriptStatusCode', 'onStatusCode', 'onStatusName', 'updateStatusCode', 'error'
    ];

    const combinedWriter = createObjectCsvWriter({
        path: combinedFile,
        header: headers.map(h => ({ id: h, title: h }))
    });

    let allData = [];

    for (let i = 1; i <= chunkCount; i++) {
        const chunkPath = path.join(config.outputDir, `chunk_${i}.csv`);
        const chunkData = fs.readFileSync(chunkPath, 'utf8').split('\n').slice(1).filter(Boolean);

        const headerLine = i === 1 ? headers.join(',') + '\n' : '';
        const bodyLines = chunkData.join('\n');

        if (headerLine || bodyLines) {
            fs.appendFileSync(combinedFile, headerLine + bodyLines + '\n');
        }

        fs.unlinkSync(chunkPath);
    }

    console.log(`Финальный результат сохранен в final_result.csv`);
}

processImeis().catch(console.error);
