import Link from "next/link";

export default function Navbar() {
  return (
    <nav
      style={{
        backgroundColor: "#2563eb",
        color: "white",
        padding: "15px 20px",
        borderRadius: "8px",
        marginBottom: "20px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "15px",
        }}
      >
        <h2 style={{ margin: 0 }}>🔍 Lost & Found Platform</h2>

        <div
          style={{
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <Link href="/" style={linkStyle}>
            🏠 Home
          </Link>

          <Link href="/lost" style={linkStyle}>
            🔍 Lost Items
          </Link>

          <Link href="/found" style={linkStyle}>
            🎒 Found Items
          </Link>

          <Link href="/report" style={linkStyle}>
            ➕ Report Item
          </Link>
        </div>
      </div>
    </nav>
  );
}

const linkStyle = {
  color: "white",
  textDecoration: "none",
  padding: "8px 12px",
  borderRadius: "6px",
  backgroundColor: "rgba(255,255,255,0.15)",
};