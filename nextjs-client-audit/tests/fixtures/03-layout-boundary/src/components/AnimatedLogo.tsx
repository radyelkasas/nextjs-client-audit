"use client";

import { motion } from "framer-motion";

export function AnimatedLogo() {
  return <motion.div animate={{ rotate: 360 }} transition={{ duration: 2 }} className="logo-mark" />;
}
