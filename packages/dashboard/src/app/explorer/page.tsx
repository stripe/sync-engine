'use client'

import dynamic from 'next/dynamic'

// Dynamically import the explorer client component with SSR disabled
// This prevents WASM-related webpack errors during server-side rendering
const ExplorerClient = dynamic(() => import('./ExplorerClient'), {
  ssr: false,
  loading: () => <ExplorerLoadingSkeleton />,
})

export default function ExplorerPage() {
  return <ExplorerClient />
}

// Loading skeleton that mimics the explorer layout
function ExplorerLoadingSkeleton() {
  return (
    <div style={styles.container}>
      {/* Left Sidebar Skeleton */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <div style={styles.skeletonTitle} />
          <div style={styles.skeletonSubtitle} />
        </div>
        <div style={styles.sidebarContent}>
          {[...Array(8)].map((_, i) => (
            <div key={i} style={styles.skeletonTableItem}>
              <div style={styles.skeletonTableName} />
              <div style={styles.skeletonRowCount} />
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel Skeleton */}
      <div style={styles.rightPanel}>
        {/* Editor Skeleton */}
        <div style={styles.editorPanel}>
          <div style={styles.panelHeader}>
            <div style={styles.skeletonHeaderText} />
            <div style={styles.skeletonButton} />
          </div>
          <div style={styles.editorContent}>
            <div style={styles.skeletonEditorLine} />
            <div style={styles.skeletonEditorLine} />
          </div>
        </div>

        {/* Results Skeleton */}
        <div style={styles.resultsPanel}>
          <div style={styles.panelHeader}>
            <div style={styles.skeletonHeaderText} />
          </div>
          <div style={styles.resultsContent}>
            <div style={styles.loadingContainer}>
              <div style={styles.spinner} />
              <div style={styles.loadingText}>Loading explorer...</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Styles for the skeleton loader
const styles = {
  container: {
    display: 'flex',
    height: '100vh',
    width: '100%',
    backgroundColor: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  } as React.CSSProperties,

  sidebar: {
    width: '280px',
    height: '100%',
    borderRight: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
    display: 'flex',
    flexDirection: 'column' as const,
    flexShrink: 0,
  } as React.CSSProperties,

  sidebarHeader: {
    padding: '20px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fff',
  } as React.CSSProperties,

  sidebarContent: {
    flex: 1,
    padding: '8px',
    overflowY: 'auto' as const,
  } as React.CSSProperties,

  skeletonTitle: {
    height: '24px',
    width: '120px',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
    marginBottom: '8px',
  } as React.CSSProperties,

  skeletonSubtitle: {
    height: '16px',
    width: '80px',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
  } as React.CSSProperties,

  skeletonTableItem: {
    padding: '12px',
    margin: '2px 0',
    backgroundColor: '#fff',
    borderRadius: '6px',
    border: '1px solid transparent',
  } as React.CSSProperties,

  skeletonTableName: {
    height: '16px',
    width: '60%',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
    marginBottom: '6px',
  } as React.CSSProperties,

  skeletonRowCount: {
    height: '14px',
    width: '40%',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
  } as React.CSSProperties,

  rightPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
  } as React.CSSProperties,

  editorPanel: {
    height: '40%',
    display: 'flex',
    flexDirection: 'column' as const,
    borderBottom: '1px solid #e0e0e0',
  } as React.CSSProperties,

  resultsPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,

  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
  } as React.CSSProperties,

  skeletonHeaderText: {
    height: '18px',
    width: '100px',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
  } as React.CSSProperties,

  skeletonButton: {
    height: '36px',
    width: '140px',
    backgroundColor: '#e0e0e0',
    borderRadius: '6px',
  } as React.CSSProperties,

  editorContent: {
    flex: 1,
    padding: '20px',
    backgroundColor: '#fff',
  } as React.CSSProperties,

  skeletonEditorLine: {
    height: '18px',
    width: '80%',
    backgroundColor: '#e0e0e0',
    borderRadius: '4px',
    marginBottom: '12px',
  } as React.CSSProperties,

  resultsContent: {
    flex: 1,
    backgroundColor: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,

  loadingContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '20px',
  } as React.CSSProperties,

  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #f0f0f0',
    borderTop: '4px solid #0070f3',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  } as React.CSSProperties,

  loadingText: {
    fontSize: '16px',
    color: '#666',
  } as React.CSSProperties,
}

// Add keyframes for spinner animation
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `
  document.head.appendChild(style)
}
