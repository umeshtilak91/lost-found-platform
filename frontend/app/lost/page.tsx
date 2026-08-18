"use client";

import { useEffect, useState } from "react";
import ItemCard from "../../components/ItemCard";
import BackButton from "../../components/BackButton";
import type { Item } from "../../types/item";

export default function LostPage() {
  const [lostItems, setLostItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function fetchLostItems() {
      try {
        const response = await fetch(
          "http://localhost:5000/api/lost-items"
        );

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status}`);
        }

        const data: Item[] = await response.json();
        setLostItems(data);
      } catch (error) {
        console.error("Failed to fetch lost items:", error);
      }
    }

    fetchLostItems();
  }, []);

  const filteredItems = lostItems.filter((item) => {
    const searchText = search.toLowerCase();

    return (
      item.name.toLowerCase().includes(searchText) ||
      item.location.toLowerCase().includes(searchText)
    );
  });

  return (
    <main style={{ padding: "30px" }}>
      <BackButton />

      <h1>🔍 Lost Items</h1>

      <div>
        <input
          type="text"
          placeholder="Search by item name or location..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            maxWidth: "500px",
            padding: "12px",
            marginTop: "15px",
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
            marginLeft: "10px",
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
              user_name={item.user_name}
              user_profile_image={item.user_profile_image}
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
            🔍 No lost items found.
          </p>
        )}
      </div>
    </main>
  );
}