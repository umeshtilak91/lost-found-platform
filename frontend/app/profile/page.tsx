"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type User = {
    id: number;
    name: string;
    email: string;
    profile_image: string | null;
    mobile_number: string | null;
    allow_phone_contact: boolean;
};

type Item = {
    id: number;
    name: string;
    location: string;
    date: string;
    description: string;
    image: string | null;
    type: "lost" | "found";
    created_at: string;
};

export default function ProfilePage() {
    const [user, setUser] = useState<User | null>(null);

    const [mobileNumber, setMobileNumber] = useState("");
    const [allowPhoneContact, setAllowPhoneContact] = useState(false);

    const [myItems, setMyItems] = useState<Item[]>([]);

    const [imageError, setImageError] = useState(false);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [editing, setEditing] = useState(false);

    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    // ======================================================
    // GET CURRENT USER + MY ITEMS
    // ======================================================

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                // Get current logged-in user
                const response = await fetch(
                    "http://localhost:5000/api/auth/me",
                    {
                        credentials: "include",
                    }
                );

                const data = await response.json();

                if (!data.loggedIn) {
                    setError("Please login with Google first.");
                    setLoading(false);
                    return;
                }

                setUser(data.user);
                setImageError(false);

                setMobileNumber(
                    data.user.mobile_number || ""
                );

                setAllowPhoneContact(
                    data.user.allow_phone_contact || false
                );

                // ======================================================
                // GET USER'S POSTED ITEMS
                // ======================================================

                const itemsResponse = await fetch(
                    "http://localhost:5000/api/auth/my-items",
                    {
                        credentials: "include",
                    }
                );

                const itemsData = await itemsResponse.json();

                if (itemsResponse.ok) {
                    setMyItems(itemsData);
                }
            } catch (err) {
                console.error("Profile loading error:", err);
                setError("Unable to load profile.");
            } finally {
                setLoading(false);
            }
        };

        fetchProfile();
    }, []);

    // ======================================================
    // SAVE PROFILE
    // ======================================================

    const handleSave = async () => {
        setMessage("");
        setError("");
        setSaving(true);

        try {
            const response = await fetch(
                "http://localhost:5000/api/auth/profile",
                {
                    method: "PUT",
                    credentials: "include",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        mobile_number: mobileNumber,
                        allow_phone_contact: allowPhoneContact,
                    }),
                }
            );

            const data = await response.json();

            if (!response.ok) {
                setError(
                    data.message ||
                        "Failed to update profile."
                );
                return;
            }

            // Update user with saved data
            setUser(data.user);

            setMobileNumber(
                data.user.mobile_number || ""
            );

            setAllowPhoneContact(
                data.user.allow_phone_contact || false
            );

            // Exit edit mode
            setEditing(false);

            // Success message
            setMessage(
                "Profile updated successfully!"
            );

            // Remove success message after 3 seconds
            setTimeout(() => {
                setMessage("");
            }, 3000);
        } catch (err) {
            console.error(
                "Profile update error:",
                err
            );

            setError(
                "Something went wrong. Please try again."
            );
        } finally {
            setSaving(false);
        }
    };

    // ======================================================
    // LOADING
    // ======================================================

    if (loading) {
        return (
            <main
                style={{
                    minHeight: "100vh",
                    background: "#020617",
                    color: "white",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    fontFamily: "Arial, sans-serif",
                }}
            >
                Loading profile...
            </main>
        );
    }

    // ======================================================
    // NOT LOGGED IN
    // ======================================================

    if (!user) {
        return (
            <main
                style={{
                    minHeight: "100vh",
                    background: "#020617",
                    color: "white",
                    padding: "40px",
                    fontFamily: "Arial, sans-serif",
                }}
            >
                <Link
                    href="/"
                    style={{
                        display: "inline-block",
                        marginBottom: "20px",
                        padding: "10px 16px",
                        borderRadius: "8px",
                        background:
                            "rgba(255,255,255,0.15)",
                        color: "white",
                        textDecoration: "none",
                        fontWeight: "bold",
                    }}
                >
                    ← Back to Home
                </Link>

                <h1>👤 My Profile</h1>

                <p
                    style={{
                        color: "#f87171",
                    }}
                >
                    {error || "Please login first."}
                </p>
            </main>
        );
    }

    // ======================================================
    // PROFILE PAGE
    // ======================================================

    return (
        <main
            style={{
                minHeight: "100vh",
                background: "#020617",
                color: "white",
                padding: "30px 20px 60px",
                fontFamily: "Arial, sans-serif",
            }}
        >
            <div
                style={{
                    maxWidth: "900px",
                    margin: "0 auto",
                }}
            >
                {/* ======================================================
                    BACK TO HOME
                ====================================================== */}

                <Link
                    href="/"
                    style={{
                        display: "inline-block",
                        marginBottom: "25px",
                        padding: "10px 16px",
                        borderRadius: "8px",
                        background:
                            "rgba(255,255,255,0.15)",
                        color: "white",
                        textDecoration: "none",
                        fontWeight: "bold",
                    }}
                >
                    ← Back to Home
                </Link>

                {/* ======================================================
                    PAGE TITLE
                ====================================================== */}

                <h1
                    style={{
                        fontSize: "32px",
                        marginBottom: "30px",
                    }}
                >
                    👤 My Profile
                </h1>

                {/* ======================================================
                    SUCCESS MESSAGE
                ====================================================== */}

                {message && (
                    <div
                        style={{
                            marginBottom: "20px",
                            padding: "12px 15px",
                            borderRadius: "8px",
                            background: "#064e3b",
                            color: "#6ee7b7",
                            fontWeight: "bold",
                        }}
                    >
                        ✅ {message}
                    </div>
                )}

                {/* ======================================================
                    ERROR MESSAGE
                ====================================================== */}

                {error && (
                    <div
                        style={{
                            marginBottom: "20px",
                            padding: "12px 15px",
                            borderRadius: "8px",
                            background: "#450a0a",
                            color: "#fca5a5",
                        }}
                    >
                        ❌ {error}
                    </div>
                )}

                {/* ======================================================
                    PROFILE CARD
                ====================================================== */}

                <div
                    style={{
                        background: "#111827",
                        borderRadius: "16px",
                        padding: "30px",
                        border: "1px solid #1f2937",
                    }}
                >
                    {/* PROFILE HEADER */}

                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "20px",
                            marginBottom: "30px",
                        }}
                    >
                        {user.profile_image &&
                        !imageError ? (
                            <img
                                src={user.profile_image}
                                alt={user.name}
                                referrerPolicy="no-referrer"
                                onError={() =>
                                    setImageError(true)
                                }
                                style={{
                                    width: "80px",
                                    height: "80px",
                                    borderRadius: "50%",
                                    objectFit: "cover",
                                    display: "block",
                                }}
                            />
                        ) : (
                            <div
                                style={{
                                    width: "80px",
                                    height: "80px",
                                    borderRadius: "50%",
                                    background: "#0284c7",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "40px",
                                    fontWeight: "bold",
                                    color: "white",
                                }}
                            >
                                {user.name
                                    ?.charAt(0)
                                    .toUpperCase() ||
                                    "U"}
                            </div>
                        )}

                        <div>
                            <h2
                                style={{
                                    margin: 0,
                                    fontSize: "26px",
                                }}
                            >
                                {user.name}
                            </h2>

                            <p
                                style={{
                                    marginTop: "6px",
                                    marginBottom: 0,
                                    color: "#9ca3af",
                                }}
                            >
                                {user.email}
                            </p>
                        </div>
                    </div>

                    {/* DIVIDER */}

                    <div
                        style={{
                            height: "1px",
                            background: "#374151",
                            marginBottom: "25px",
                        }}
                    />

                    {/* ======================================================
                        NORMAL PROFILE VIEW
                    ====================================================== */}

                    {!editing ? (
                        <>
                            {/* MOBILE NUMBER */}

                            <div
                                style={{
                                    marginBottom: "20px",
                                }}
                            >
                                <div
                                    style={{
                                        color: "#9ca3af",
                                        fontSize: "14px",
                                        marginBottom: "6px",
                                    }}
                                >
                                    Mobile Number
                                </div>

                                <div
                                    style={{
                                        fontSize: "18px",
                                        fontWeight: "bold",
                                    }}
                                >
                                    {user.mobile_number ||
                                        "Not added"}
                                </div>
                            </div>

                            {/* PHONE CONTACT */}

                            <div
                                style={{
                                    marginBottom: "25px",
                                }}
                            >
                                <div
                                    style={{
                                        color: "#9ca3af",
                                        fontSize: "14px",
                                        marginBottom: "6px",
                                    }}
                                >
                                    Phone Contact
                                </div>

                                <div
                                    style={{
                                        fontSize: "16px",
                                        fontWeight: "bold",
                                    }}
                                >
                                    {user.allow_phone_contact ? (
                                        <span
                                            style={{
                                                color: "#4ade80",
                                            }}
                                        >
                                            ☑ People can contact me
                                            by phone
                                        </span>
                                    ) : (
                                        <span
                                            style={{
                                                color: "#9ca3af",
                                            }}
                                        >
                                            ☐ Phone contact disabled
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* EDIT PROFILE */}

                            <button
                                onClick={() => {
                                    setEditing(true);
                                    setError("");
                                    setMessage("");
                                }}
                                style={{
                                    width: "100%",
                                    padding: "14px",
                                    border: "none",
                                    borderRadius: "8px",
                                    background: "#2563eb",
                                    color: "white",
                                    fontSize: "16px",
                                    fontWeight: "bold",
                                    cursor: "pointer",
                                }}
                            >
                                ✏️ Edit Profile
                            </button>
                        </>
                    ) : (
                        <>
                            {/* ======================================================
                                EDIT PROFILE
                            ====================================================== */}

                            <label
                                style={{
                                    display: "block",
                                    fontWeight: "bold",
                                    marginBottom: "8px",
                                }}
                            >
                                Mobile Number
                            </label>

                            <input
                                type="tel"
                                value={mobileNumber}
                                onChange={(e) =>
                                    setMobileNumber(
                                        e.target.value
                                    )
                                }
                                placeholder="+91 9876543210"
                                style={{
                                    width: "100%",
                                    padding: "13px",
                                    borderRadius: "8px",
                                    border: "1px solid #374151",
                                    background: "#020617",
                                    color: "white",
                                    fontSize: "16px",
                                    boxSizing: "border-box",
                                    marginBottom: "20px",
                                }}
                            />

                            {/* PHONE CONTACT CHECKBOX */}

                            <label
                                style={{
                                    display: "flex",
                                    alignItems:
                                        "flex-start",
                                    gap: "12px",
                                    cursor: "pointer",
                                    marginBottom: "25px",
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={
                                        allowPhoneContact
                                    }
                                    onChange={(e) =>
                                        setAllowPhoneContact(
                                            e.target.checked
                                        )
                                    }
                                    style={{
                                        width: "18px",
                                        height: "18px",
                                        marginTop: "2px",
                                    }}
                                />

                                <span>
                                    <strong>
                                        Allow people to contact
                                        me by phone
                                    </strong>

                                    <br />

                                    <small
                                        style={{
                                            color: "#9ca3af",
                                        }}
                                    >
                                        Your mobile number will
                                        only be shown when you
                                        enable this option.
                                    </small>
                                </span>
                            </label>

                            {/* CANCEL + SAVE */}

                            <div
                                style={{
                                    display: "flex",
                                    gap: "10px",
                                }}
                            >
                                <button
                                    onClick={() => {
                                        setEditing(false);

                                        // Restore saved values
                                        setMobileNumber(
                                            user.mobile_number ||
                                                ""
                                        );

                                        setAllowPhoneContact(
                                            user.allow_phone_contact ||
                                                false
                                        );

                                        setError("");
                                    }}
                                    disabled={saving}
                                    style={{
                                        flex: 1,
                                        padding: "14px",
                                        border: "1px solid #374151",
                                        borderRadius: "8px",
                                        background: "#020617",
                                        color: "white",
                                        fontSize: "16px",
                                        fontWeight: "bold",
                                        cursor: saving
                                            ? "not-allowed"
                                            : "pointer",
                                    }}
                                >
                                    Cancel
                                </button>

                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    style={{
                                        flex: 1,
                                        padding: "14px",
                                        border: "none",
                                        borderRadius: "8px",
                                        background: saving
                                            ? "#374151"
                                            : "#16a34a",
                                        color: "white",
                                        fontSize: "16px",
                                        fontWeight: "bold",
                                        cursor: saving
                                            ? "not-allowed"
                                            : "pointer",
                                    }}
                                >
                                    {saving
                                        ? "Saving..."
                                        : "Save Changes"}
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {/* ======================================================
                    MY POSTED ITEMS
                ====================================================== */}

                <div
                    style={{
                        marginTop: "30px",
                        background: "#111827",
                        borderRadius: "16px",
                        padding: "30px",
                        border: "1px solid #1f2937",
                    }}
                >
                    <h2
                        style={{
                            marginTop: 0,
                            marginBottom: "20px",
                            fontSize: "24px",
                        }}
                    >
                        📦 My Posted Items
                    </h2>

                    {myItems.length === 0 ? (
                        <p
                            style={{
                                color: "#9ca3af",
                            }}
                        >
                            You have not posted any items yet.
                        </p>
                    ) : (
                        <div
                            style={{
                                display: "grid",
                                gap: "15px",
                            }}
                        >
                            {myItems.map((item) => (
                                <div
                                    key={item.id}
                                    style={{
                                        padding: "18px",
                                        borderRadius: "10px",
                                        background: "#020617",
                                        border: "1px solid #374151",
                                    }}
                                >
                                    {/* ITEM HEADER */}

                                    <div
                                        style={{
                                            display: "flex",
                                            justifyContent:
                                                "space-between",
                                            alignItems: "center",
                                            gap: "10px",
                                            marginBottom: "10px",
                                        }}
                                    >
                                        <h3
                                            style={{
                                                margin: 0,
                                                fontSize: "20px",
                                            }}
                                        >
                                            {item.name}
                                        </h3>

                                        <span
                                            style={{
                                                padding:
                                                    "5px 10px",
                                                borderRadius: "6px",
                                                background:
                                                    item.type ===
                                                    "lost"
                                                        ? "#7f1d1d"
                                                        : "#14532d",
                                                fontSize: "13px",
                                                fontWeight:
                                                    "bold",
                                            }}
                                        >
                                            {item.type.toUpperCase()}
                                        </span>
                                    </div>

                                    {/* LOCATION */}

                                    <p
                                        style={{
                                            margin: "6px 0",
                                            color: "#9ca3af",
                                        }}
                                    >
                                        📍 {item.location}
                                    </p>

                                    {/* DATE */}

                                    <p
                                        style={{
                                            margin: "6px 0",
                                            color: "#9ca3af",
                                        }}
                                    >
                                        📅 {item.date}
                                    </p>

                                    {/* DESCRIPTION */}

                                    <p
                                        style={{
                                            margin:
                                                "12px 0 0",
                                            color: "#d1d5db",
                                        }}
                                    >
                                        {item.description}
                                    </p>

                                    {/* ITEM IMAGE */}

                                    {item.image && (
                                        <img
                                            src={`http://localhost:5000/uploads/${item.image}`}
                                            alt={item.name}
                                            style={{
                                                width: "100%",
                                                maxHeight:
                                                    "250px",
                                                objectFit:
                                                    "cover",
                                                borderRadius:
                                                    "8px",
                                                marginTop:
                                                    "15px",
                                            }}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ======================================================
                    BOTTOM BACK TO HOME
                ====================================================== */}

                <div
                    style={{
                        textAlign: "center",
                        marginTop: "30px",
                    }}
                >
                    <Link
                        href="/"
                        style={{
                            display: "inline-block",
                            padding: "12px 22px",
                            borderRadius: "8px",
                            background:
                                "rgba(255,255,255,0.15)",
                            color: "white",
                            textDecoration: "none",
                            fontWeight: "bold",
                        }}
                    >
                        ← Back to Home
                    </Link>
                </div>
            </div>
        </main>
    );
}