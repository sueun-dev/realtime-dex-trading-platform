import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional compact fallback (used for the chart sub-boundary). */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Top-level error boundary. Catches render/runtime errors below it and shows a
 * recoverable Korean fallback instead of an unmounted white screen. A finer
 * boundary can wrap a single panel (e.g. the chart) with a compact `fallback`
 * so one failing widget doesn't take down the whole trading view.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('UI error boundary caught:', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="error-fallback" role="alert">
        <div className="error-fallback-title">문제가 발생했습니다</div>
        <p className="dim">화면을 새로고침하면 다시 시도할 수 있습니다.</p>
        <div className="error-fallback-actions">
          <button type="button" className="small-btn accent-btn" onClick={this.reset}>
            다시 시도
          </button>
          <button
            type="button"
            className="small-btn"
            onClick={() => {
              window.location.reload();
            }}
          >
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
