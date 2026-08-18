"use client";

import { useState } from "react";
import BackButton from "../../components/BackButton";

export default function ReportPage() {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [type, setType] = useState("lost");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const formData = new FormData();

      formData.append("name", name);
      formData.append("location", location);
      formData.append("date", date);
      formData.append("description", description);
      formData.append("type", type);

      if (image) {
        formData.append("image", image);
      }

      const response = await fetch("http://localhost:5000/api/report", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      const data = await response.json();

      console.log("Report response:", response.status, data);

      if (response.status === 401) {
        alert("Please login with Google first.");
        return;
      }

      if (!response.ok) {
        alert(data.message || "Failed to submit report.");
        return;
      }

      console.log("✅ Report created:", data.item);

      alert("✅ Report submitted successfully!");

      setName("");
      setLocation("");
      setDate("");
      setDescription("");
      setImage(null);
      setType("lost");
    } catch (error) {
      console.error("Report submission error:", error);
      alert("Unable to connect to backend.");
    }
  };

  return (
    <main style={{ padding: "30px", maxWidth: "600px" }}>
      <BackButton />

      <h1>Report Lost / Found Item</h1>

      <p>Item Name: {name}</p>
      <p>Location: {location}</p>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "15px" }}>
          <label>What are you reporting?</label>
          <br />

          <label>
            <input
              type="radio"
              name="type"
              value="lost"
              checked={type === "lost"}
              onChange={(e) => setType(e.target.value)}
            />
            Lost Item
          </label>

          <br />

          <label>
            <input
              type="radio"
              name="type"
              value="found"
              checked={type === "found"}
              onChange={(e) => setType(e.target.value)}
            />
            Found Item
          </label>
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label>Item Name</label>
          <br />

          <input
            type="text"
            placeholder="Enter item name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%", padding: "8px" }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label>Location</label>
          <br />

          <input
            type="text"
            placeholder="Where was it lost/found?"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={{ width: "100%", padding: "8px" }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label>Date</label>
          <br />

          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: "100%", padding: "8px" }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label>Description</label>
          <br />

          <textarea
            placeholder="Describe the item"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: "100%", padding: "8px" }}
          />
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label>Upload Image</label>
          <br />

          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                setImage(e.target.files[0]);
              }
            }}
          />
        </div>

        <button type="submit">
          Submit Report
        </button>
      </form>
    </main>
  );
}