# LinLearn Buildroot Guest OS VM Configuration Specifications

This document defines the build configuration specifications for generating the minimal WebAssembly guest Linux image (`linux4.iso`) used in LinLearn's offline client-side simulation.

## 1. Buildroot Target System Settings
*   **Target Architecture:** i386 (Intel Pentium II/III compatible, optimized for low-overhead browser emulation)
*   **Target Binary Format:** ELF
*   **Target ABI:** ELF
*   **Floating Point Helper:** Soft-float (increases compatibility across low-end mobile/web browser client devices)

## 2. Kernel & Boot Configuration
*   **Linux Kernel Version:** `4.19.x` (Long-Term Support, highly stable footprint)
*   **Kernel Configuration:** Minimalist configuration tailored for serial console output and v86 hardware capabilities.
    *   Disable graphics cards drivers, sound boards, USB controllers, and PCI networking (relying on guest serial streams).
    *   Enable VirtIO console and 9P filesystem support.
*   **Init System:** `BusyBox init` (ultra-fast boot time under 1.5 seconds)

## 3. Package Selection Checklist (Standard Unix Utilities)
To support training modules, the following utility libraries are selected and compiled into the Buildroot image:

```ini
# System shell selection
BR2_SYSTEM_BIN_SH_BASH=y

# Core Utilities (replacing light BusyBox equivalents for exact POSIX compliance)
BR2_PACKAGE_COREUTILS=y
BR2_PACKAGE_FINDUTILS=y
BR2_PACKAGE_GREP=y
BR2_PACKAGE_SED=y
BR2_PACKAGE_TAR=y
BR2_PACKAGE_GZIP=y

# Networking Utilities
BR2_PACKAGE_IPROUTE2=y
BR2_PACKAGE_IPTABLES=y
BR2_PACKAGE_NETCAT=y
BR2_PACKAGE_CURL=y

# Process / Administration tools
BR2_PACKAGE_HTOP=y
BR2_PACKAGE_PROCPS_NG=y  # provides full ps, top, kill, free
BR2_PACKAGE_SUDO=y
```

## 4. Userspace Accounts & Permissions Schema
*   `root`: Password-less root access for simulation initialization and validation hooks.
*   `user` (UID 1000): Standard training operator account with limited privileges. Assigned to group `wheel` for sudo exercises.
*   Home directories preloaded with:
    *   `/home/user/Projects` (Writable user playground)

## 5. Build Script Template (`build.sh`)
```bash
#!/usr/bin/env bash
# LinLearn Buildroot ISO Image generator pipeline

set -euo pipefail

BUILDROOT_VER="2023.02.10"
wget https://buildroot.org/downloads/buildroot-${BUILDROOT_VER}.tar.gz
tar -xzf buildroot-${BUILDROOT_VER}.tar.gz
cd buildroot-${BUILDROOT_VER}

# Inject LinLearn custom configuration defconfig
cp ../configs/linlearn_defconfig .config

# Compile kernel and rootfs (Outputs images/rootfs.iso9660 or images/bzImage)
make -j$(nproc)

# Copy output artifact
cp output/images/rootfs.iso ../linux4.iso
echo "Build complete! Minimal iso generated at ../linux4.iso"
```
