"use client";

import { useEffect, useState } from "react";
import ItemCard from "../../components/ItemCard";
import type { Item } from "../../types/item";

export default function LostPage() {

    const [lostItems, setLostItems] = useState<Item[]>([]);
    useEffect(() => {
  async function fetchLostItems() {
    try {
      const response = await fetch("http://localhost:5000/api/lost-items");

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
  return (
    <main style={{ padding: "30px" }}>
      <h1>🔍 Lost Items</h1>

      {lostItems.map((item) => (
        <ItemCard
          key={item.id}
          name={item.name}
          location={item.location}
          date={item.date}
        />
      ))}
    </main>
  );
}