// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { createTestSite, deleteTestSite, createCollection } from './helpers/setup-tenants.js';

// Setup phase: run once before the test starts
export function setup() {
  const BASE_URL = __ENV.BASE_URL || 'http://localhost:1989';
  const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || 'dev:admin@heopress.example:admin';

  const siteA = 'site_leak_test_a';
  const siteB = 'site_leak_test_b';

  console.log(`Setting up test tenants: ${siteA}, ${siteB}`);

  // Create sites
  createTestSite(BASE_URL, siteA, 'Tenant A', ADMIN_TOKEN);
  createTestSite(BASE_URL, siteB, 'Tenant B', ADMIN_TOKEN);

  // Create collection 'posts' in both sites
  createCollection(BASE_URL, siteA, 'posts', ADMIN_TOKEN);
  createCollection(BASE_URL, siteB, 'posts', ADMIN_TOKEN);

  return {
    baseUrl: BASE_URL,
    siteA,
    siteB,
    adminToken: ADMIN_TOKEN,
    tokenA: `dev:user_a@heopress.example:admin`,
    tokenB: `dev:user_b@heopress.example:admin`,
  };
}

export default function (data) {
  const { baseUrl, siteA, siteB, tokenA, tokenB } = data;

  const headersA = {
    'Authorization': `Bearer ${tokenA}`,
    'X-HeoPress-Site': siteA,
    'Content-Type': 'application/json',
  };

  const headersB = {
    'Authorization': `Bearer ${tokenB}`,
    'X-HeoPress-Site': siteB,
    'Content-Type': 'application/json',
  };

  // ---------------------------------------------------------------------------
  // Scenario 1: Data isolation
  // Create item in site_a, read list from site_b -> verify 0 results.
  // ---------------------------------------------------------------------------
  const createRes = http.post(
    `${baseUrl}/api/v1/items/posts`,
    JSON.stringify({ data: { title: 'Secret Post in Tenant A' }, status: 'published' }),
    { headers: headersA }
  );
  check(createRes, { 'item created in site_a': (r) => r.status === 201 });
  const itemIdA = createRes.json()?.data?.id;

  // Query site_b posts
  const listB = http.get(`${baseUrl}/api/v1/items/posts`, { headers: headersB });
  check(listB, {
    'site_b cannot see site_a data': (r) => {
      const items = r.json()?.data || [];
      return items.filter((item) => item.id === itemIdA).length === 0;
    },
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Auth isolation
  // site_a token calls site_b endpoints -> verify 403.
  // ---------------------------------------------------------------------------
  const crossSiteRes = http.get(
    `${baseUrl}/api/v1/items/posts`,
    {
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'X-HeoPress-Site': siteB,
      },
    }
  );
  // In HeoPress, if token does not have access to siteB (no userSites row), it returns 403.
  check(crossSiteRes, {
    'site_a token rejected on site_b': (r) => r.status === 403,
  });


  // ---------------------------------------------------------------------------
  // Scenario 4: Search isolation
  // Search items site_a -> verify no items from site_b
  // ---------------------------------------------------------------------------
  // First, create a post in site_b
  const createB = http.post(
    `${baseUrl}/api/v1/items/posts`,
    JSON.stringify({ data: { title: 'Tenant B Search Post' }, status: 'published' }),
    { headers: headersB }
  );
  check(createB, { 'item created in site_b': (r) => r.status === 201 });
  const itemIdB = createB.json()?.data?.id;

  // Search site_a
  const searchA = http.get(
    `${baseUrl}/api/v1/search?q=Search`,
    { headers: headersA }
  );
  check(searchA, {
    'search site_a does not leak site_b': (r) => {
      const results = r.json()?.data || [];
      return results.filter((res) => res.id === itemIdB).length === 0;
    },
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Realtime isolation
  // ws subscribe site_a -> create item site_b -> verify no event received
  // ---------------------------------------------------------------------------
  const ticketResA = http.post(`${baseUrl}/api/v1/realtime/ticket`, null, {
    headers: headersA
  });

  check(ticketResA, { 'got realtime ticket for site A': (r) => r.status === 200 });
  const ticketA = ticketResA.json().data?.ticket;

  const wsUrl = baseUrl.replace(/^http/, 'ws') + `/api/v1/realtime?ticket=${ticketA}&site=${siteA}`;
  
  let wsEventLeaked = false;
  
  const wsRes = ws.connect(wsUrl, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        collection: 'posts',
        event: ['create'],
      }));

      // Trigger mutation on site_b after subscription starts
      socket.setTimeout(() => {
        http.post(
          `${baseUrl}/api/v1/items/posts`,
          JSON.stringify({ data: { title: 'Tenant B Realtime Post' }, status: 'published' }),
          { headers: headersB }
        );
      }, 500);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'event' && msg.payload?.title === 'Tenant B Realtime Post') {
          wsEventLeaked = true;
        }
      } catch (err) {}
    });

    socket.setTimeout(() => {
      socket.close();
    }, 2000);
  });

  check(wsRes, { 'ws connected': (r) => r && r.status === 101 });
  
  // Wait for WS connection to complete
  sleep(2.5);
  
  check(wsEventLeaked, {
    'no realtime leak from site_b to site_a': (l) => l === false,
  });
}

// Teardown phase: runs once after all VUs finish
export function teardown(data) {
  const { baseUrl, siteA, siteB, adminToken } = data;
  console.log(`Cleaning up test tenants: ${siteA}, ${siteB}`);
  deleteTestSite(baseUrl, siteA, adminToken);
  deleteTestSite(baseUrl, siteB, adminToken);
}
