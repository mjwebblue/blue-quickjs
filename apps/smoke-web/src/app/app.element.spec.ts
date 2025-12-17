import { AppElement } from './app.element';

describe('AppElement', () => {
  let app: AppElement;

  beforeEach(() => {
    app = new AppElement();
  });

  it('should create successfully', () => {
    expect(app).toBeTruthy();
  });

  it('should have a greeting', () => {
    app.connectedCallback();

    const heading = app.querySelector('h1');

    expect(heading).not.toBeNull();
    expect(heading?.textContent ?? '').toContain('Deterministic QuickJS');
  });
});
