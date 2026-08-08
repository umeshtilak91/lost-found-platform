"use client";

import { useState } from "react";



export default function ReportPage() {

    const [name, setName] = useState("");
    const [location, setLocation] = useState("");
    const [date, setDate] = useState("");
    const [description, setDescription] = useState("");
    const [image, setImage] = useState<File | null>(null);
    const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  const formData = new FormData();

  formData.append("name", name);
  formData.append("location", location);
  formData.append("date", date);
  formData.append("description", description);

  if (image) {
    formData.append("image", image);
  }

  const response = await fetch("http://localhost:5000/api/report", {
    method: "POST",
    body: formData,
  });

  const data = await response.json();

  console.log(data);

  setName("");
  setLocation("");
  setDate("");
  setDescription("");
  setImage(null);

  alert("Report submitted successfully!");
};

  




  return (
    <main style={{ padding: "30px", maxWidth: "600px" }}>
      <h1>Report Lost / Found Item</h1>
      <p>Item Name: {name}</p>
      <p>Location: {location}</p>

      <form onSubmit={handleSubmit}>
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
                placeholder="Where was it lost?"
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