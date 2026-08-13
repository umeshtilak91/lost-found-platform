"use client";

import { useEffect, useState } from "react";
import ItemCard from "../../components/ItemCard";
import type { Item } from "../../types/item";

export default function FoundPage() {
  const [foundItems, setFoundItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function fetchFoundItems() {
      try {
        const response = await fetch(
          "http://localhost:5000/api/found-items"
        );

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status}`);
        }

        const data: Item[] = await response.json();
        setFoundItems(data);
      } catch (error) {
        console.error("Failed to fetch found items:", error);
      }
    }

    fetchFoundItems();
  }, []);

  const filteredItems = foundItems.filter((item) => {
    const searchText = search.toLowerCase();

    return (
      item.name.toLowerCase().includes(searchText) ||
      item.location.toLowerCase().includes(searchText)
    );
  });

  return (
    <main style={{ padding: "30px" }}>
      <h1>🎒 Found Items</h1>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginTop: "15px",
        }}
      >
        <input
          type="text"
          placeholder="Search by item name or location..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            maxWidth: "500px",
            padding: "12px",
            borderRadius: "8px",
            border: "1px solid #555",
            fontSize: "16px",
            background: "#111",
            color: "white",
          }}
        />

        <button
          onClick={() => setSearch("")}
          style={{
            padding: "12px 18px",
            borderRadius: "8px",
            border: "1px solid #555",
            cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "20px",
          marginTop: "20px",
        }}
      >
        {filteredItems.length > 0 ? (
          filteredItems.map((item) => (
            <ItemCard
              key={item.id}
              name={item.name}
              location={item.location}
              date={item.date}
              description={item.description}
              image={item.image}
            />
          ))
        ) : (
          <p
            style={{
              gridColumn: "1 / -1",
              textAlign: "center",
              padding: "40px",
              color: "#aaa",
              fontSize: "18px",
            }}
          >
            🔍 No found items found.
          </p>
        )}
      </div>
    </main>
  );
}