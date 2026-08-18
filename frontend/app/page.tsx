import Navbar from "../components/Navbar";
import Hero from "../components/Hero";


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
      <Navbar />

      <Hero />

      <h2>Features</h2>

      <ul>
        <li>🏠 Home</li>
        <li>🔍 Search Lost Items</li>
        <li>📦 Lost Items</li>
        <li>🎒 Found Items</li>
        <li>➕ Report Item</li>
      </ul>

     
    </main>
  );
}