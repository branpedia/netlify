const cloudscraper = require('cloudscraper');
const { JSDOM } = require('jsdom');
const chromium = require('chrome-aws-lambda');
const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async function(event, context) {
  // Handle CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: ''
    };
  }

  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: 'Method not allowed'
      })
    };
  }

  const { url } = event.queryStringParameters;

  if (!url) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: 'Parameter URL diperlukan'
      })
    };
  }

  try {
    // Validate MediaFire URL
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/'))) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          success: false,
          error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.'
        })
      };
    }

    // Coba beberapa metode untuk mendapatkan data
    let result = null;
    
    // Metode 1: CloudScraper + JSDOM
    try {
      result = await getWithCloudScraper(url);
      console.log('Metode CloudScraper berhasil');
    } catch (error) {
      console.log('Metode CloudScraper gagal:', error.message);
    }
    
    // Metode 2: Puppeteer (jika metode 1 gagal)
    if (!result || !result.downloadUrl) {
      try {
        result = await getWithPuppeteer(url);
        console.log('Metode Puppeteer berhasil');
      } catch (error) {
        console.log('Metode Puppeteer gagal:', error.message);
      }
    }
    
    // Metode 3: Axios + Cheerio (jika metode lain gagal)
    if (!result || !result.downloadUrl) {
      try {
        result = await getWithAxios(url);
        console.log('Metode Axios berhasil');
      } catch (error) {
        console.log('Metode Axios gagal:', error.message);
      }
    }

    if (!result || !result.downloadUrl) {
      throw new Error('Tidak dapat mengambil data dari MediaFire dengan metode apapun');
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        data: result
      })
    };

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: error.message || 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.'
      })
    };
  }
};

// Metode 1: CloudScraper + JSDOM
async function getWithCloudScraper(url) {
  return new Promise((resolve, reject) => {
    cloudscraper.get(url, (error, res, body) => {
      if (error) {
        reject(error);
        return;
      }
      
      try {
        const dom = new JSDOM(body);
        const document = dom.window.document;
        const result = extractMediaFireData(document, body);
        resolve(result);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// Metode 2: Puppeteer
async function getWithPuppeteer(url) {
  let browser = null;
  try {
    // Setup puppeteer untuk environment Netlify
    const executablePath = await chromium.executablePath;
    
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    const page = await browser.newPage();
    
    // Set user agent untuk menyerupai browser asli
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigasi ke URL
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Tunggu hingga elemen download muncul
    await page.waitForSelector('#downloadButton', { timeout: 10000 });
    
    // Dapatkan HTML setelah JavaScript dieksekusi
    const body = await page.content();
    const dom = new JSDOM(body);
    const document = dom.window.document;
    
    const result = extractMediaFireData(document, body);
    
    await browser.close();
    return result;
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// Metode 3: Axios + Cheerio
async function getWithAxios(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const body = response.data;
    
    // Ekstrak data menggunakan Cheerio
    const fileName = $('.dl-btn-label').attr('title') || $('.dl-btn-label').text().trim() || 'Unknown File';
    
    // Cari URL download
    let downloadUrl = '';
    const downloadButton = $('a[data-scrambled-url]');
    
    if (downloadButton.length) {
      const scrambledUrl = downloadButton.attr('data-scrambled-url');
      if (scrambledUrl) {
        downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
      }
    }
    
    // Jika tidak ditemukan, coba cari di dalam script
    if (!downloadUrl) {
      const scriptRegex = /data-scrambled-url="([^"]+)"/;
      const match = body.match(scriptRegex);
      if (match && match[1]) {
        downloadUrl = Buffer.from(match[1], 'base64').toString('utf8');
      }
    }
    
    // Extract file size
    let fileSize = 'Unknown';
    const sizeElement = $('.file-size');
    if (sizeElement.length) {
      fileSize = sizeElement.text().trim();
    } else {
      // Coba ekstrak dari teks tombol download
      const downloadText = $('#downloadButton').text();
      const sizeMatch = downloadText.match(/\(([^)]+)\)/);
      if (sizeMatch && sizeMatch[1]) {
        fileSize = sizeMatch[1];
      }
    }
    
    // Extract upload date
    const uploadDate = $('.date-added').text().trim() || $('.UploadedDate').text().trim() || 'Unknown';
    
    // Extract file extension
    const fileExtension = fileName.includes('.') ? 
      fileName.split('.').pop() : 'unknown';
    
    return {
      name: fileName,
      size: fileSize,
      extension: fileExtension,
      uploaded: uploadDate,
      downloadUrl: downloadUrl
    };
  } catch (error) {
    throw new Error(`Axios error: ${error.message}`);
  }
}

// Fungsi untuk mengekstrak data MediaFire dari DOM
function extractMediaFireData(document, body) {
  // Extract file name
  const fileNameElement = document.querySelector('.dl-btn-label');
  const fileName = fileNameElement ? 
    (fileNameElement.getAttribute('title') || fileNameElement.textContent.trim()) : 
    'Unknown File';

  // Extract download URL from data-scrambled-url attribute
  const downloadButton = document.querySelector('a[data-scrambled-url]');
  let downloadUrl = '';

  if (downloadButton) {
    const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
    if (scrambledUrl) {
      // Decode base64 URL
      downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
    }
  }

  // Alternative method to extract download URL from onclick handler
  if (!downloadUrl) {
    const urlMatch = body.match(/data-scrambled-url="([^"]+)"/);
    if (urlMatch && urlMatch[1]) {
      downloadUrl = Buffer.from(urlMatch[1], 'base64').toString('utf8');
    }
  }

  // Extract file size
  let fileSize = 'Unknown';
  const fileSizeElement = document.querySelector('.file-size');
  if (fileSizeElement) {
    fileSize = fileSizeElement.textContent.trim();
  } else {
    // Coba ekstrak dari teks tombol download
    const downloadButtonText = document.querySelector('#downloadButton');
    if (downloadButtonText) {
      const downloadText = downloadButtonText.textContent;
      const sizeMatch = downloadText.match(/\(([^)]+)\)/);
      if (sizeMatch && sizeMatch[1]) {
        fileSize = sizeMatch[1];
      }
    }
  }

  // Extract upload date
  const uploadDateElement = document.querySelector('.date-added') || document.querySelector('.UploadedDate');
  const uploadDate = uploadDateElement ? uploadDateElement.textContent.trim() : 'Unknown';

  // Extract file extension
  const fileExtension = fileName.includes('.') ? 
    fileName.split('.').pop() : 'unknown';

  return {
    name: fileName,
    size: fileSize,
    extension: fileExtension,
    uploaded: uploadDate,
    downloadUrl: downloadUrl
  };
}
