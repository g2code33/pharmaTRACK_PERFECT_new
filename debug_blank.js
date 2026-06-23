import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', error => console.log('BROWSER ERROR:', error.message));
  
  console.log("Navigating to local dev server...");
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 10000 });
    const content = await page.content();
    if(content.includes('id="root"></div>')) {
      console.log("Root is empty! Something crashed.");
    } else {
      console.log("App rendered successfully.");
    }
  } catch(e) {
    console.log("Navigation error:", e.message);
  }
  
  await browser.close();
  process.exit(0);
})();
