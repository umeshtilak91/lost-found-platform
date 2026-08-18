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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleImageChange = (file: File | null) => {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please select an image file.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert("Image size should be less than 10MB.");
      return;
    }

    setImage(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      alert("Please enter the item name.");
      return;
    }

    if (!location.trim()) {
      alert("Please enter the location.");
      return;
    }

    if (!date) {
      alert("Please select a date.");
      return;
    }

    if (!description.trim()) {
      alert("Please enter a description.");
      return;
    }

    try {
      setIsSubmitting(true);

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
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "30px 20px 60px",
        background:
            "radial-gradient(circle at top left, #172554 0%, #0f172a 35%, #020617 75%)",
        color: "white",
      }}
    >
      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
        }}
      >
        <BackButton />

        {/* Header */}
        <div style={{ marginTop: "25px", marginBottom: "25px" }}>
          <div
            style={{
              display: "inline-block",
              padding: "6px 12px",
              borderRadius: "20px",
              background: "rgba(37, 99, 235, 0.15)",
              color: "#60a5fa",
              fontSize: "13px",
              fontWeight: "600",
              marginBottom: "12px",
            }}
          >
            COMMUNITY HELP
          </div>

          <h1
            style={{
              fontSize: "36px",
              margin: "0 0 10px",
              fontWeight: "700",
            }}
          >
            Report an Item
          </h1>

          <p
            style={{
              margin: 0,
              color: "#999",
              fontSize: "16px",
              lineHeight: "1.6",
            }}
          >
            Help someone find their lost belongings or report something
            you've found.
          </p>
        </div>

        {/* Form Card */}
        <div
          style={{
            background: "#151515",
            border: "1px solid #292929",
            borderRadius: "16px",
            padding: "28px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
          }}
        >
          <form onSubmit={handleSubmit}>
            {/* Lost / Found */}
            <div style={{ marginBottom: "28px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "14px",
                  fontWeight: "600",
                  marginBottom: "10px",
                }}
              >
                What are you reporting?
              </label>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setType("lost")}
                  style={{
                    padding: "16px",
                    borderRadius: "10px",
                    border:
                      type === "lost"
                        ? "2px solid #2563eb"
                        : "1px solid #444",
                    background:
                      type === "lost" ? "rgba(37,99,235,0.15)" : "#1c1c1c",
                    color: "white",
                    cursor: "pointer",
                    fontSize: "15px",
                    fontWeight: "600",
                  }}
                >
                  🔍 I Lost It
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#999",
                      marginTop: "5px",
                    }}
                  >
                    Report something you lost
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setType("found")}
                  style={{
                    padding: "16px",
                    borderRadius: "10px",
                    border:
                      type === "found"
                        ? "2px solid #2563eb"
                        : "1px solid #444",
                    background:
                      type === "found" ? "rgba(37,99,235,0.15)" : "#1c1c1c",
                    color: "white",
                    cursor: "pointer",
                    fontSize: "15px",
                    fontWeight: "600",
                  }}
                >
                  🎒 I Found It
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#999",
                      marginTop: "5px",
                    }}
                  >
                    Report something you found
                  </div>
                </button>
              </div>
            </div>

            {/* Item Name */}
            <div style={{ marginBottom: "22px" }}>
              <label style={labelStyle}>
                Item Name <span style={{ color: "#ef4444" }}>*</span>
              </label>

              <input
                type="text"
                placeholder="e.g. Black leather wallet"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Location */}
            <div style={{ marginBottom: "22px" }}>
              <label style={labelStyle}>
                Location <span style={{ color: "#ef4444" }}>*</span>
              </label>

              <input
                type="text"
                placeholder="Where was it lost or found?"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Date */}
            <div style={{ marginBottom: "22px" }}>
              <label style={labelStyle}>
                Date <span style={{ color: "#ef4444" }}>*</span>
              </label>

              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={{
                  ...inputStyle,
                  colorScheme: "dark",
                }}
              />
            </div>

            {/* Description */}
            <div style={{ marginBottom: "22px" }}>
              <label style={labelStyle}>
                Description <span style={{ color: "#ef4444" }}>*</span>
              </label>

              <textarea
                placeholder="Describe the item, color, brand, identifying marks, etc."
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{
                  ...inputStyle,
                  resize: "vertical",
                  minHeight: "130px",
                }}
              />

              <div
                style={{
                  textAlign: "right",
                  marginTop: "5px",
                  color: "#666",
                  fontSize: "12px",
                }}
              >
                {description.length} characters
              </div>
            </div>

            {/* Image Upload */}
            <div style={{ marginBottom: "28px" }}>
              <label style={labelStyle}>Photo</label>

              {!image ? (
                <label
                  style={{
                    display: "block",
                    border: "2px dashed #444",
                    borderRadius: "12px",
                    padding: "35px 20px",
                    textAlign: "center",
                    cursor: "pointer",
                    background: "#101010",
                  }}
                >
                  <div style={{ fontSize: "36px", marginBottom: "10px" }}>
                    📷
                  </div>

                  <div
                    style={{
                      fontWeight: "600",
                      marginBottom: "6px",
                    }}
                  >
                    Click to upload a photo
                  </div>

                  <div
                    style={{
                      color: "#777",
                      fontSize: "13px",
                    }}
                  >
                    JPG, PNG or other image formats • Max 10MB
                  </div>

                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      handleImageChange(
                        e.target.files && e.target.files.length > 0
                          ? e.target.files[0]
                          : null
                      );
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              ) : (
                <div
                  style={{
                    border: "1px solid #333",
                    borderRadius: "12px",
                    padding: "12px",
                    background: "#101010",
                  }}
                >
                  <img
                    src={URL.createObjectURL(image)}
                    alt="Preview"
                    style={{
                      width: "100%",
                      maxHeight: "280px",
                      objectFit: "contain",
                      borderRadius: "8px",
                      background: "#050505",
                    }}
                  />

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: "10px",
                      gap: "10px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "13px",
                        color: "#aaa",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {image.name}
                    </span>

                    <button
                      type="button"
                      onClick={() => setImage(null)}
                      style={{
                        border: "1px solid #444",
                        background: "#222",
                        color: "#fff",
                        padding: "7px 12px",
                        borderRadius: "6px",
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "15px",
                border: "none",
                borderRadius: "10px",
                background: isSubmitting ? "#555" : "#2563eb",
                color: "white",
                fontSize: "16px",
                fontWeight: "600",
                cursor: isSubmitting ? "not-allowed" : "pointer",
              }}
            >
              {isSubmitting
                ? "Submitting..."
                : type === "lost"
                ? "🔍 Submit Lost Item"
                : "🎒 Submit Found Item"}
            </button>

            <p
              style={{
                textAlign: "center",
                color: "#666",
                fontSize: "12px",
                marginTop: "15px",
                marginBottom: 0,
              }}
            >
              Your report will be linked to your Google account.
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}

const labelStyle = {
  display: "block",
  fontSize: "14px",
  fontWeight: "600",
  marginBottom: "8px",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "13px 14px",
  borderRadius: "9px",
  border: "1px solid #3a3a3a",
  background: "#101010",
  color: "white",
  fontSize: "15px",
  outline: "none",
};