import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type BrowserTestSite = {
  topOrigin: string;
  oopifOrigin: string;
  close(): Promise<void>;
};

export async function startBrowserTestSite(): Promise<BrowserTestSite> {
  const oopif = await listen('127.0.0.1', (request, response) => {
    if (request.url === '/payment') {
      html(response, `<!doctype html><html><body>
        <h1>Payment frame</h1>
        <button id="pay" type="button">Pay now</button>
        <script>document.querySelector('#pay').addEventListener('click', () => { document.body.dataset.paid = 'yes'; });</script>
      </body></html>`);
      return;
    }
    notFound(response);
  });
  const oopifOrigin = `http://jojo-frame.test:${oopif.port}`;
  const top = await listen('127.0.0.1', (request, response) => {
    if (request.url === '/' || request.url === '/checkout') {
      html(response, `<!doctype html><html><body>
        <h1>Checkout</h1>
        <iframe id="profile" src="/profile"></iframe>
        <iframe name="payment" src="${oopifOrigin}/payment"></iframe>
      </body></html>`);
      return;
    }
    if (request.url === '/checkout-duplicate') {
      html(response, `<!doctype html><html><body>
        <h1>Duplicate payment frames</h1>
        <iframe name="payment" src="${oopifOrigin}/payment#primary"></iframe>
        <iframe name="backup-payment" src="${oopifOrigin}/payment#backup"></iframe>
      </body></html>`);
      return;
    }
    if (request.url === '/profile') {
      html(response, '<!doctype html><html><body><button id="save-profile">Save profile</button></body></html>');
      return;
    }
    notFound(response);
  });
  return {
    topOrigin: `http://jojo-top.test:${top.port}`,
    oopifOrigin,
    close: async () => {
      await Promise.all([top.close(), oopif.close()]);
    }
  };
}

function listen(host: string, handler: http.RequestListener): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, host, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((done, fail) => {
          server.closeAllConnections();
          server.close((error) => error ? fail(error) : done());
        })
      });
    });
    server.on('error', reject);
  });
}

function html(response: http.ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function notFound(response: http.ServerResponse): void {
  response.writeHead(404);
  response.end('Not found');
}
