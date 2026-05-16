const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err));
  
  await page.goto('http://localhost:8000/servers.html', {waitUntil: 'networkidle2'});
  
  await page.evaluate(() => {
    // Override wait behavior for testing
    window.myUserId = '123';
    window.myServers = [{id:'server1', name:'Test Server', owner_id:'123', invite_code:'ABCDEF'}];
    openServer('server1');
  });
  
  await new Promise(r => setTimeout(r, 1000));
  
  await page.evaluate(() => {
    const btn = document.querySelector('button[title="Invite friends"]');
    if(btn) btn.click();
    else console.log('BUTTON NOT FOUND');
  });
  
  await new Promise(r => setTimeout(r, 1000));
  
  const isOpen = await page.evaluate(() => document.getElementById('inviteModal').classList.contains('open'));
  console.log('IS MODAL OPEN?', isOpen);
  
  await browser.close();
})();
