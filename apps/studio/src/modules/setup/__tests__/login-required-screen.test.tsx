// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminReadyLoginRequiredScreen, loginHrefFor } from '../admin-ready-gate';

describe('loginHrefFor', () => {
  it('links any well-formed admin path to its sign-in page', () => {
    expect(loginHrefFor('/my-admin')).toBe('/my-admin/login');
    expect(loginHrefFor('/my-admin/content/articles/a1')).toBe('/my-admin/login');
    expect(loginHrefFor('/somewhere-else/x')).toBe('/somewhere-else/login');
  });

  it('gives no link where no admin path can be', () => {
    expect(loginHrefFor('/')).toBeNull();
    expect(loginHrefFor('/ab')).toBeNull();
    expect(loginHrefFor('/Not_A_Path')).toBeNull();
  });
});

describe('AdminReadyLoginRequiredScreen', () => {
  it('offers the sign-in page instead of "Not found"', () => {
    render(<AdminReadyLoginRequiredScreen currentPath="/my-admin/sites" />);
    expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/my-admin/login');
    expect(screen.queryByText('Not found')).toBeNull();
  });

  it('points to the saved admin URL at the root', () => {
    render(<AdminReadyLoginRequiredScreen currentPath="/" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/admin URL saved at the end of setup/)).toBeTruthy();
  });
});
