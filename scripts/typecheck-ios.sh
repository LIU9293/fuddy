#!/bin/zsh
set -euo pipefail

repo_root=${0:A:h:h}
xcode_root=/Applications/Xcode.app/Contents/Developer
swiftc_bin=$xcode_root/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc
ios_sdk=$xcode_root/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk
ios_platform=$xcode_root/Platforms/iPhoneOS.platform/Developer
whisper_framework=$repo_root/.third-party-tools/whisper/v1.9.2/build-apple/whisper.xcframework/ios-arm64
module_dir=$(mktemp -d /tmp/project-agent-ios-module.XXXXXX)
trap 'rm -rf "$module_dir"' EXIT

if [[ ! -x $swiftc_bin || ! -d $ios_sdk ]]; then
  echo "Xcode iOS SDK was not found under /Applications/Xcode.app." >&2
  exit 1
fi

$swiftc_bin \
  -emit-module \
  -parse-as-library \
  -enable-testing \
  -swift-version 6 \
  -sdk $ios_sdk \
  -target arm64-apple-ios17.0 \
  -F $whisper_framework \
  -module-name ProjectAgentCompanion \
  -emit-module-path $module_dir/ProjectAgentCompanion.swiftmodule \
  $repo_root/ios/ProjectAgentCompanion/*.swift

$swiftc_bin \
  -typecheck \
  -swift-version 6 \
  -sdk $ios_sdk \
  -target arm64-apple-ios17.0 \
  -F $whisper_framework \
  -F $ios_platform/Library/Frameworks \
  -I $ios_platform/usr/lib \
  -I $module_dir \
  $repo_root/ios/ProjectAgentCompanionTests/*.swift

echo "Swift 6 app and test sources typechecked successfully."
