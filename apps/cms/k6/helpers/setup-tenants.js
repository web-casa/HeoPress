// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import http from 'k6/http';

export function createTestSite(baseUrl, siteId, siteName, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/instance/sites`,
    JSON.stringify({ id: siteId, name: siteName }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-HeoPress-Site': 'site_demo', // use existing demo site for admin request mapping
      },
    }
  );
  if (res.status !== 201) {
    throw new Error(`Failed to create test site ${siteId}: Status ${res.status} - ${res.body}`);
  }
  return res.json().data;
}

export function deleteTestSite(baseUrl, siteId, adminToken) {
  const res = http.del(
    `${baseUrl}/api/v1/instance/sites/${siteId}`,
    null,
    {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'X-HeoPress-Site': 'site_demo',
      },
    }
  );
  return res.status === 200;
}

export function createCollection(baseUrl, siteId, collectionName, adminToken) {
  const res = http.post(
    `${baseUrl}/api/v1/collections`,
    JSON.stringify({ name: collectionName }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
        'X-HeoPress-Site': siteId,
      },
    }
  );
  if (res.status !== 201) {
    throw new Error(`Failed to create collection ${collectionName} on ${siteId}: Status ${res.status}`);
  }
  return res.json().data;
}

