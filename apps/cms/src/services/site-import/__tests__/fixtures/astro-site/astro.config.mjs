import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://www.example.com',
  trailingSlash: 'always',
  redirects: {
    '/about-us': '/about/',
    '/legacy': { status: 302, destination: '/blog/' },
  },
});
