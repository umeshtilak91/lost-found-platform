export default function Home() {
  return (
    <main
      style={{
        maxWidth: "800px",
        margin: "40px auto",
        padding: "30px",
        fontFamily: "Arial, sans-serif",
        border: "1px solid #ddd",
        borderRadius: "10px",
      }}
    >
      <h1>🔍 Lost & Found Platform</h1>

      <p>
        Welcome to our community-driven platform to report and search for lost
        and found items.
      </p>

      <h2>Features</h2>

      <ul>
        <li>🏠 Home</li>
        <li>🔍 Search Lost Items</li>
        <li>📦 Lost Items</li>
        <li>🎒 Found Items</li>
        <li>➕ Report Item</li>
      </ul>

      <button
        style={{
          backgroundColor: "#2563eb",
          color: "white",
          padding: "12px 20px",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          marginTop: "20px",
        }}
      >
        Login with Google (Coming Soon)
      </button>
    </main>
  );
}