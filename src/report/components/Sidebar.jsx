import UserInfo from "./UserInfo";

import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {  Menu, X,  } from "lucide-react";
import { IoMdSettings } from "react-icons/io";
import { BiSolidDashboard } from "react-icons/bi";
import { BsBarChartFill } from "react-icons/bs";
import { FiLogOut } from "react-icons/fi";
import { useAuth } from "../../auth/AuthContext";


export default function Sidebar({ currentPath = "/reports" }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const sidebarUser = {
    name: user?.name ?? "Edward Morhe",
    profile:
      user?.avatar ??
      "https://i.pravatar.cc/150?u=edward",
  };

  // Handle responsive logic (check once + on resize)
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: BiSolidDashboard},
    { name: "Reports", href: "/reports", icon: BsBarChartFill},
    { name: "Settings", href: "/settings", icon: IoMdSettings},
  ];

  return (
    <>
      {/* Mobile Header */}
      {isMobile && (
        <div className="flex items-center justify-between bg-white text-gray-800 p-4 md:hidden">
          <div className="flex items-center gap-2">
            <img 
                src="./logo.svg" 
                alt="Dailylogs-logo" 
                className="w-35 h-12 object-fit" 
                priority="true"
            />
          </div>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="focus:outline-none focus:ring-2 focus:ring-white rounded"
            aria-label="Toggle menu"
          >
            {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-screen flex flex-col justify-between bg-white text-black p-6 z-40 transform transition-all duration-300 ease-in-out
        w-72
        ${isOpen || !isMobile ? "translate-x-0" : "-translate-x-full"}
      `}
      >
        <div>
        <div className=" bg-white pb-6 mb-6">
          <img 
            className= " w-54 h-15 object-fit bg-white" 
            src = "/logo.svg" 
            alt="Dailylogs-logo"
            priority ="true"
          />
        </div>

        {/* Navigation */}
        <nav className="space-y-3 group flex-1">
          {navigation.map(({ name, href, icon }) => {
            const Icon = icon
            const active = currentPath === href;
            return (
              <Link
                key={name}
                to={href}
                onClick={() => isMobile && setIsOpen(false)}
                className={`flex items-center gap-3 p-3 rounded-lg hover:translate-1.5  transition-all duration-200 font-semibold ${
                  active
                    ? "bg-violet-200 text-violet-700 shadow-lg font-semibold"
                    : "text-gray-500 hover:bg-violet-100 "
                }`}
              >
                <Icon className="w-5 h-5 "  />
                <span>{name}</span>
              </Link>
            );
          })}
        </nav>
        </div>

        {/* User Section */}
        <div className= " bottom-0 left-0 right-0 p-6 space-y-6">
          {/*Whoever designs that user Icon should put it here, me ataya--*/}

          <div>
            <UserInfo user={sidebarUser} />
          </div>

          <div className="group text-gray-500">
            <button
              type="button"
              onClick={() => {
                logout();
                navigate("/login", { replace: true });
              }}
              className="flex items-center gap-4 text-lg font-semibold ml-1"
            >
              <FiLogOut  className="w-7 h-7 " />
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {isMobile && isOpen && (
        <div
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 bg-black/50 z-30 md:hidden backdrop-blur-sm transition-opacity duration-300"
        />
      )}
    </>
  );
}
