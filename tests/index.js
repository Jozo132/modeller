import assert from "assert";
import { init, render, getCommandBufferPtr, getCommandBufferLen } from "../build/debug.js";

// Initialize with a canvas size
init(800, 600);

// Render should produce a non-empty command buffer
render();
const len = getCommandBufferLen();
assert.ok(len > 0, "Command buffer should have content after render");
assert.ok(getCommandBufferPtr() > 0, "Command buffer pointer should be non-zero");

console.log("ok");
