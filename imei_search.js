const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');
const readline = require('readline');

// Получаем конфигурацию
let config;
try {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (err) {
    console.error('Ошибка при чтении config.json:', err.message);
    console.log('Создаем базовую конфигурацию...');
    config = {
        username: '',
        password: '',
        requestDelay: 200
    };
}

// Устанавливаем значения по умолчанию
config.outputDir = 'results';
config.requestDelay = config.requestDelay || 200;

// Функция для интерактивного запроса параметров в терминале
function createInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

// Запрос ввода с пользователя с возможностью использования значения по умолчанию
function askQuestion(rl, question, defaultValue = '') {
    const defaultText = defaultValue ? ` (по умолчанию: ${defaultValue})` : '';
    return new Promise(resolve => {
        rl.question(`${question}${defaultText}: `, (answer) => {
            resolve(answer.trim() || defaultValue);
        });
    });
}

// Функция для получения токена доступа
async function getAccessToken(username, password) {
    try {
        const response = await axios.post('https://auth.galileosky.com/realms/GS/protocol/openid-connect/token', new URLSearchParams({
            client_id: 'ng-frontend',
            client_secret: 'QBwTDzCOK7I3NT5HH7osQw7gv2L29Ol4',
            grant_type: 'password',
            username: username,
            password: password
        }));

        return response.data.access_token;
    } catch (error) {
        console.error('Ошибка при получении токена:', error.message);
        throw new Error('Не удалось получить токен доступа');
    }
}

// Добавляем задержку между запросами
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция для получения данных устройства с повторными попытками
async function fetchDeviceData(imei, token, retryCount = 0) {
    try {
        const response = await axios.get('https://ca.galileosky.com/support/devices/search', {
            params: { query: imei, offset: 0, limit: 20 },
            headers: { Authorization: `Bearer ${token}` }
        });

        // Добавляем небольшую задержку после успешного запроса
        await delay(config.requestDelay);

        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0];
        } else {
            throw new Error('Нет данных');
        }
    } catch (error) {
        // Если получили ошибку 401, возможно, токен истек
        if (error.response && error.response.status === 401 && retryCount < 3) {
            console.log(`Токен истек или недействителен. Получаем новый токен...`);
            // Получаем новый токен и меняем глобальную переменную
            const newToken = await getAccessToken(config.username, config.password);
            // Повторяем запрос с новым токеном
            console.log(`Повторная попытка с новым токеном для IMEI ${imei}`);
            return fetchDeviceData(imei, newToken, retryCount + 1);
        }
        
        // Если это другая ошибка, но у нас еще есть попытки
        if (retryCount < 3) {
            const waitTime = (retryCount + 1) * 1000; // Увеличиваем задержку с каждой попыткой
            console.log(`Ошибка при получении данных для IMEI ${imei}: ${error.message}. Повторная попытка через ${waitTime/1000} сек...`);
            await delay(waitTime);
            return fetchDeviceData(imei, token, retryCount + 1);
        }
        
        return {
            imei,
            error: error.response ? `Код ${error.response.status}: ${error.message}` : error.message || 'Ошибка при получении данных'
        };
    }
}

async function processImeis(imeiFilePath, chunkSize) {
    // Создаем директорию для результатов если её нет
    if (!fs.existsSync(config.outputDir)) {
        fs.mkdirSync(config.outputDir, { recursive: true });
    }

    // Добавляем расширение .txt если его нет
    if (!imeiFilePath.toLowerCase().endsWith('.txt')) {
        imeiFilePath = imeiFilePath + '.txt';
    }

    console.log(`\nОбработка файла: ${imeiFilePath}`);
    console.log(`Размер чанка: ${chunkSize}`);
    
    // Проверяем, что файл существует в текущей директории
    const fullPath = path.resolve(imeiFilePath);
    
    let imeis;
    try {
        imeis = fs.readFileSync(fullPath, 'utf8')
            .trim()
            .split('\n')
            .map(i => i.trim())
            .filter(i => i);
        
        console.log(`Загружено ${imeis.length} IMEI из файла`);
    } catch (error) {
        console.error(`Ошибка при чтении файла ${fullPath}:`, error.message);
        return;
    }
    
    console.log('Получение токена доступа...');
    let token = await getAccessToken(config.username, config.password);
    console.log('Токен успешно получен');

    const errorList = [];
    const successResults = [];
    let currentChunk = 1;
    let tokenRenewCount = 0;

    const startTime = new Date();

    for (let i = 0; i < imeis.length; i++) {
        const imei = imeis[i];
        console.log(`(${i + 1}/${imeis.length}) Обработка IMEI: ${imei}`);

        // Каждые 300 запросов обновляем токен превентивно
        if (i > 0 && i % 300 === 0) {
            console.log(`Превентивное обновление токена после ${i} запросов`);
            try {
                token = await getAccessToken(config.username, config.password);
                tokenRenewCount++;
                console.log('Токен успешно обновлен');
                // Добавляем паузу после обновления токена
                await delay(1000);
            } catch (error) {
                console.error('Ошибка при обновлении токена:', error.message);
            }
        }

        let data;
        try {
            data = await fetchDeviceData(imei, token);
            // Если при получении данных был обновлен токен, обновляем и нашу локальную переменную
            if (data.newToken) {
                token = data.newToken;
                tokenRenewCount++;
                delete data.newToken;
            }
        } catch (error) {
            console.error(`Критическая ошибка при обработке IMEI ${imei}:`, error.message);
            data = {
                imei,
                error: error.message || 'Критическая ошибка при получении данных'
            };
        }

        if (data.error) {
            console.log(`Ошибка для IMEI ${imei}: ${data.error}\n`);
            errorList.push({ imei, error: data.error });
        } else {
            console.log(`Данные по IMEI ${imei} получены.\n`);
            successResults.push(data);
        }

        // Сохраняем промежуточные результаты успешных данных
        if (successResults.length >= chunkSize || i === imeis.length - 1) {
            if (successResults.length > 0) {
                await saveSuccessChunkFile(currentChunk, successResults);
                successResults.length = 0;
                currentChunk++;
            }
        }
        
        // Добавляем небольшую паузу между запросами
        if (i < imeis.length - 1) {
            await delay(config.requestDelay);
        }
    }

    // Сохраняем финальный результат
    if (currentChunk > 1) {
        await combineChunks(currentChunk - 1);
    }

    // Сохраняем ошибки в TXT файл
    if (errorList.length > 0) {
        saveErrorsToTxt(errorList);
    }

    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const minutes = Math.floor(duration / 60);
    const seconds = (duration % 60).toFixed(2);

    console.log(`\n=== Результаты обработки ===`);
    console.log(`Обработка завершена за ${minutes} мин. ${seconds} сек.`);
    console.log(`Всего обработано IMEI: ${imeis.length}`);
    console.log(`Успешно обработано: ${imeis.length - errorList.length}`);
    console.log(`Количество ошибок: ${errorList.length}`);
    console.log(`Количество обновлений токена: ${tokenRenewCount}`);
    console.log(`\nРезультаты сохранены в папке: ${config.outputDir}`);
}

// Сохраняем ошибки в TXT файл
function saveErrorsToTxt(errors) {
    const errorFile = path.join(config.outputDir, 'errors.txt');
    
    let content = 'IMEI с ошибками:\n\n';
    errors.forEach(err => {
        content += `IMEI: ${err.imei}\nОшибка: ${err.error}\n\n`;
    });
    
    fs.writeFileSync(errorFile, content);
    console.log(`Ошибочные IMEI сохранены в errors.txt (всего: ${errors.length})\n`);
    
    // Также сохраняем только список IMEI с ошибками для удобства повторной обработки
    const errorImeisFile = path.join(config.outputDir, 'error_imeis.txt');
    const imeisOnly = errors.map(err => err.imei).join('\n');
    fs.writeFileSync(errorImeisFile, imeisOnly);
    console.log(`Список IMEI с ошибками сохранен в error_imeis.txt\n`);
}

async function saveSuccessChunkFile(chunkNumber, data) {
    const filePath = path.join(config.outputDir, `chunk_${chunkNumber}.csv`);
    const headers = [
        'imei', 'name', 'customerName', 'marketingName', 'softVersion',
        'hasInvite', 'elScriptStatusCode', 'onStatusCode', 'onStatusName', 'updateStatusCode'
    ];

    const csvWriter = createObjectCsvWriter({
        path: filePath,
        header: headers.map(h => ({ id: h, title: h }))
    });

    await csvWriter.writeRecords(data);
    console.log(`Сохранен chunk-файл: ${filePath} (${data.length} записей)\n`);
}

async function combineChunks(chunkCount) {
    const combinedFile = path.join(config.outputDir, 'result.csv');
    const headers = [
        'imei', 'name', 'customerName', 'marketingName', 'softVersion',
        'hasInvite', 'elScriptStatusCode', 'onStatusCode', 'onStatusName', 'updateStatusCode'
    ];

    // Создаем файл с заголовком
    const headerLine = headers.join(',') + '\n';
    fs.writeFileSync(combinedFile, headerLine);

    let totalRecords = 0;

    for (let i = 1; i <= chunkCount; i++) {
        try {
            const chunkPath = path.join(config.outputDir, `chunk_${i}.csv`);
            if (fs.existsSync(chunkPath)) {
                // Читаем файл и пропускаем первую строку (заголовок)
                const chunkData = fs.readFileSync(chunkPath, 'utf8').split('\n').slice(1).filter(Boolean);
                
                if (chunkData.length > 0) {
                    // Добавляем данные в общий файл
                    fs.appendFileSync(combinedFile, chunkData.join('\n') + '\n');
                    totalRecords += chunkData.length;
                }
                
                // Удаляем промежуточный файл
                fs.unlinkSync(chunkPath);
            }
        } catch (error) {
            console.error(`Ошибка при обработке chunk_${i}.csv:`, error.message);
        }
    }

    console.log(`Финальный результат сохранен в result.csv (всего записей: ${totalRecords})`);
}

// Основная функция запуска скрипта
async function main() {
    const rl = createInterface();
    
    console.log('=== Скрипт обработки IMEI ===');
    
    // Проверяем наличие учетных данных в конфигурации
    if (!config.username || !config.password) {
        console.log('Необходимо ввести учетные данные для API...');
        config.username = await askQuestion(rl, 'Введите имя пользователя');
        config.password = await askQuestion(rl, 'Введите пароль');
        
        // Сохраняем учетные данные для будущего использования
        try {
            fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
            console.log('Учетные данные сохранены в config.json');
        } catch (err) {
            console.warn('Не удалось сохранить конфигурацию:', err.message);
        }
    }
    
    // Запрашиваем только необходимые параметры: имя файла и размер чанка
    const imeiFile = await askQuestion(rl, 'Введите имя файла с IMEI (в текущей директории)');
    const chunkSizeStr = await askQuestion(rl, 'Размер чанка', '100');
    
    rl.close();
    
    // Преобразуем строковое значение в число
    const chunkSize = parseInt(chunkSizeStr) || 100;
    
    // Запускаем обработку с указанными параметрами
    await processImeis(imeiFile, chunkSize);
}

// Запуск скрипта с обработкой ошибок
main().catch(error => {
    console.error('Критическая ошибка при выполнении скрипта:', error.message);
    process.exit(1);
});
