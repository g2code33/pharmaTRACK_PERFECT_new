/**
 * The password reveal toggle.
 *
 * Every masked password field in the app (login, account reset, AI vault
 * unlock, kiosk entry, the admin console gate, the exam builder gate, and
 * both password-change forms) should let the person typing check what they
 * actually typed before they submit it — a fat-fingered character or a
 * stuck caps-lock key otherwise just reads as "wrong password" with no way
 * to see why.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import PasswordInput from '../components/PasswordInput';

describe('PasswordInput', () => {
  it('starts masked', () => {
    render(<PasswordInput value="secret" onChange={() => {}} data-testid="pw" />);
    expect((screen.getByTestId('pw') as HTMLInputElement).type).toBe('password');
  });

  it('reveals and re-hides the typed value on toggle click', () => {
    render(<PasswordInput value="secret" onChange={() => {}} data-testid="pw" />);
    const input = screen.getByTestId('pw') as HTMLInputElement;
    const toggle = screen.getByTestId('pw-reveal');

    fireEvent.click(toggle);
    expect(input.type).toBe('text');

    fireEvent.click(toggle);
    expect(input.type).toBe('password');
  });

  it('keeps the reveal button out of the tab order so Enter-to-submit habits still work', () => {
    render(<PasswordInput value="secret" onChange={() => {}} data-testid="pw" />);
    expect(screen.getByTestId('pw-reveal').getAttribute('tabIndex')).toBe('-1');
  });

  it('is a plain button, never a submit control, inside a form', () => {
    render(<PasswordInput value="secret" onChange={() => {}} data-testid="pw" />);
    expect(screen.getByTestId('pw-reveal').getAttribute('type')).toBe('button');
  });

  it('announces its state for assistive tech', () => {
    render(<PasswordInput value="secret" onChange={() => {}} data-testid="pw" />);
    const toggle = screen.getByTestId('pw-reveal');
    expect(toggle.getAttribute('aria-label')).toMatch(/show/i);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-label')).toMatch(/hide/i);
  });
});

describe('password fields app-wide use the reveal toggle', () => {
  const files = [
    '../pages/ExaminationAdmin.tsx',
    '../pages/ExaminationBuilder.tsx',
    '../pages/KioskEntry.tsx',
    '../pages/Login.tsx',
    '../pages/ResetPassword.tsx',
    '../components/AISettingsPanel.tsx',
  ];

  it('have no bare <input type="password"> left anywhere in the app', () => {
    for (const file of files) {
      const src = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(src).not.toMatch(/<input[^>]*type="password"/);
    }
  });

  it('every one of those files imports and uses PasswordInput', () => {
    for (const file of files) {
      const src = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(src).toMatch(/import PasswordInput from/);
      expect(src).toMatch(/<PasswordInput\b/);
    }
  });
});
