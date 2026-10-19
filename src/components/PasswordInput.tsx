import React, { forwardRef, useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * A drop-in replacement for `<input type="password">` that adds a reveal
 * toggle. Students and invigilators both type high-stakes passwords
 * (exam join, builder lock, admin console, account login) into masked
 * fields with no way to confirm what they actually typed before submitting
 * — a fat-fingered character or a stuck caps-lock key just reads as
 * "wrong password" with no way to tell why. The eye button lets anyone
 * check their input before they submit it.
 *
 * Drop-in means: same props as a native input (value/onChange/className/
 * placeholder/data-testid/autoComplete/etc.) — callers do not need to
 * change their layout, only swap the tag name. The toggle button is
 * absolutely positioned inside a wrapping `relative` box, and the input
 * gets right-side padding reserved for it.
 */
export interface PasswordInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
> {
  /** Class name for the positioning wrapper (the input's own className is
   *  left untouched aside from the reserved right padding). */
  wrapperClassName?: string;
  /** Pixel padding reserved for the reveal button. Override for unusually
   *  small or large inputs; 2.5rem (40px) fits every size used today. */
  revealButtonClassName?: string;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    { className = '', wrapperClassName = '', revealButtonClassName = '', style, ...rest },
    ref,
  ) {
    const [visible, setVisible] = useState(false);
    const reactId = useId();
    const testId = (rest as Record<string, unknown>)['data-testid'];
    const toggleTestId = typeof testId === 'string' ? `${testId}-reveal` : undefined;

    return (
      <div className={`relative ${wrapperClassName}`.trim()}>
        <input
          {...rest}
          ref={ref}
          id={rest.id ?? reactId}
          type={visible ? 'text' : 'password'}
          className={className}
          // An inline style always wins over whatever padding-right utility
          // class the caller's own `className` happens to carry (Tailwind's
          // cascade order depends on build-wide class discovery order, not
          // on the order classes are listed on one element) — so the reveal
          // button never ends up sitting on top of the typed text.
          style={{ ...style, paddingRight: '2.25rem' }}
        />
        <button
          type="button"
          // Revealing a password is a read action on the field next to it,
          // never a form submit — keep it out of the normal tab stop so
          // Enter-to-submit habits and tab order both still behave.
          tabIndex={-1}
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          data-testid={toggleTestId}
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-current opacity-50 transition hover:opacity-100 focus:opacity-100 focus:outline-none ${revealButtonClassName}`.trim()}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);

export default PasswordInput;
