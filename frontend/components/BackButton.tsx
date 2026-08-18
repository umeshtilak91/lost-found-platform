"use client";

import { useRouter } from "next/navigation";

export default function BackButton() {
  const router = useRouter();

  return (
    <button
      onClick={() => router.back()}
      style={{
        padding: "8px 14px",
        marginBottom: "20px",
        backgroundColor: "#374151",
        color: "white",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "15px",
      }}
    >
      ← Back
    </button>
  );
}