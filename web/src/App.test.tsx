import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App', () => {
  it('renders the portal heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /CRE Transaction Portal/i })).toBeInTheDocument();
  });
});
