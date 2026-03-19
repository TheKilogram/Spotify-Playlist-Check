import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class RootErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { hasError: boolean }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
            color: '#fff',
            fontFamily: 'sans-serif',
          }}
        >
          <div
            style={{
              maxWidth: '540px',
              padding: '20px',
              borderRadius: '16px',
              background: 'rgba(0,0,0,0.55)',
            }}
          >
            <strong>Something went wrong while loading the app.</strong>
            <p>
              Refresh once. If it happens again, open the browser console and
              share the first error message.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
