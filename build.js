import { promises as fs } from 'fs';
import { CookieJar, JSDOM, ResourceLoader } from 'jsdom';
import { dirname, join } from 'path';
import { URL } from 'url';

const STORE_URL = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const NEW_WEBSITE_URL = process.env.NEW_WEBSITE_URL;

const SHOPIFY_STORE_PASSWORD = process.env.SHOPIFY_STORE_PASSWORD;
const BUILD_DIR = './build';

const HEADERS = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'fr-FR,fr;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Expires: '0',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Signature-Input': process.env.SHOPIFY_SIGNATURE_INPUT,
  Signature: process.env.SHOPIFY_SIGNATURE,
  'Signature-Agent': '"https://shopify.com"',
};

class CustomResourceLoader extends ResourceLoader {
  fetch(url, options) {
    options.headers = {
      ...options.headers,
      ...HEADERS,
    };
    return super.fetch(url, options);
  }
}

const resourceLoader = new CustomResourceLoader();

const cookieJar = new CookieJar();

// Authentifier avec le mot de passe de la boutique
async function authenticateStorefront() {
  console.log('Authenticating with storefront password...');

  try {
    // 1. Charger la page de mot de passe pour obtenir les cookies initiaux
    await JSDOM.fromURL(`${STORE_URL}/password`, {
      cookieJar,
      resources: resourceLoader,
      // runScripts: 'dangerously'
    });

    // 2. Soumettre le formulaire de mot de passe via fetch natif avec les cookies
    const formData = new URLSearchParams({
      // form_type: 'SHOPIFY_STORE_PASSWORD',
      utf8: '✓',
      password: SHOPIFY_STORE_PASSWORD,
    });

    // Récupérer les cookies du jar
    const cookies = await cookieJar.getCookieString(STORE_URL);

    const response = await fetch(`${STORE_URL}/password`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookies,
      },
      body: formData.toString(),
      redirect: 'manual',
    });

    const newCookies = response.headers.getSetCookie();
    for (const cookie of newCookies) {
      await cookieJar.setCookie(cookie, STORE_URL);
    }

    console.log('Authenticated successfully');
  } catch (error) {
    console.error('Authentication failed:', error.message);
    throw error;
  }
}

async function parseShopifySitemap(mainSitemapUrl) {
  console.log(`Parsing main sitemap: ${mainSitemapUrl}`);
  try {
    // 1. Fetch le sitemap principal
    const response = await fetch(mainSitemapUrl, {
      headers: { ...HEADERS, Cookie: await cookieJar.getCookieString(STORE_URL) },
    });
    const mainSitemapXml = await response.text();

    // 2. Parser avec jsdom (XML)
    const dom = new JSDOM(mainSitemapXml, { contentType: 'text/xml' });
    const document = dom.window.document;

    // 3. Vérifier si c'est un sitemap index ou un sitemap simple

    return await parseSitemapIndex(document, mainSitemapUrl);
  } catch (error) {
    console.error('Error parsing sitemap:', error.message);
    throw error;
  }
}

async function parseSitemapIndex(document) {
  const allUrls = [
    STORE_URL,
    `${STORE_URL}/policies/legal-notice`,
    `${STORE_URL}/policies/terms-of-service`,
    `${STORE_URL}/policies/privacy-policy`,
  ];

  // Extraire toutes les URLs des sous-sitemaps
  const sitemapElements = document.querySelectorAll('sitemap > loc');
  const subSitemapUrls = Array.from(sitemapElements).map((el) => el.textContent.trim());

  console.log(`Found ${subSitemapUrls.length} sub-sitemaps`);

  // Fetch et parser chaque sous-sitemap

  for (const subSitemapUrl of subSitemapUrls) {
    console.log(`Fetching: ${subSitemapUrl}`);

    try {
      // Fetch le sous-sitemap
      const response = await fetch(subSitemapUrl, {
        headers: { ...HEADERS, Cookie: await cookieJar.getCookieString(STORE_URL) },
      });

      const subSitemapXml = await response.text();

      // Parser avec jsdom
      const subDom = new JSDOM(subSitemapXml, { contentType: 'text/xml' });
      const subDocument = subDom.window.document;

      // Extraire les URLs
      const urls = Array.from(subDocument.querySelectorAll('urlset > url > loc')).map((el) => el.textContent.trim());

      console.log(`  → Found ${urls.length} URLs`);
      allUrls.push(...urls);

      await sleep(200);
    } catch (error) {
      console.error(`  ✗ Failed to fetch ${subSitemapUrl}:`, error.message);
    }
  }

  console.log(`\nTotal URLs extracted: ${allUrls.length}`);
  return allUrls;
}

function generateSitemap(urls) {
  return `
    <?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${urls
      .map((url) => {
        return `<url><loc>${new URL(url).pathname}</loc><lastmod>${new Date().toISOString()}</lastmod></url>`;
      })
      .join('\n')}
    </urlset>
  `;
}

// Télécharger une page avec jsdom
async function downloadPageWithJsdom(pageUrl, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Downloading: ${pageUrl}`);

      // Ajouter preview_theme_id à l'URL
      const url = new URL(pageUrl);

      // Charger la page avec jsdom
      const dom = await JSDOM.fromURL(url.href, {
        cookieJar,
        resources: resourceLoader,
        // runScripts: 'outside-only',
        // pretendToBeVisual: true,
      });

      return dom;
    } catch (error) {
      console.error(`Error (attempt ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) return null;
      await sleep(2000 * (i + 1));
    }
  }
}

// Nettoyer le DOM
function cleanDOM(dom, pageUrl) {
  if (!dom) return '';
  const document = dom.window.document;

  // Cleaner la head
  // Supprimer tous les scripts indesirables
  const scriptsToRemove = document.querySelectorAll(
    'head script:not([data-keep]):not([type="application/ld+json"]):not([type="importmap"])',
  );
  scriptsToRemove.forEach((script) => script.remove());

  // Supprimer tous les autres éléments indesirables
  document
    .querySelectorAll('link[href="https://monorail-edge.shopifysvc.com"], #shopify-digital-wallet')
    .forEach((element) => element.remove());

  return dom
    .serialize()
    .replaceAll(STORE_URL, NEW_WEBSITE_URL)
    .replaceAll(STORE_URL.replaceAll('/', '\\/'), NEW_WEBSITE_URL.replaceAll('/', '\\/'));
}

// Sauvegarder le fichier
async function saveFile(filePath, content) {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  console.log(`Saved: ${filePath}`);
}

// Convertir URL en chemin de fichier
function urlToFilePath(pageUrl) {
  let pathname = new URL(pageUrl).pathname || '/';
  pathname += pathname.endsWith('/') ? 'index.html' : '.html';

  return join(BUILD_DIR, pathname);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Crawler principal
async function crawlSite(urls) {
  for (const url of urls) {
    console.log(`\nProcessing: ${url}`);
    const dom = await downloadPageWithJsdom(url);
    const cleanedHTML = cleanDOM(dom, url);

    // await saveFile(urlToFilePath(url), dom.serialize());
    if (cleanedHTML) await saveFile(urlToFilePath(url), cleanedHTML);

    // return;

    // Pause progressive
    await sleep(300 + Math.random() * 200);
  }
}

async function main() {
  console.log('=== Shopify Theme Clone with jsdom ===');

  // Create build folder
  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  await fs.mkdir(BUILD_DIR, { recursive: true });

  // 1. Authentification
  // await authenticateStorefront();

  // 3. Récupérer les urls dans la sitemap
  const urls = await parseShopifySitemap(`${STORE_URL}/sitemap.xml`);
  console.log(urls);

  // Crawl le site
  crawlSite(urls);

  return;

  // Génère la nouvelle sitemap
  const sitemap = generateSitemap(urls);
  await saveFile(join(BUILD_DIR, 'sitemap.xml'), sitemap);
}

main();
