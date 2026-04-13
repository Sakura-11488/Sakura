const fs = require('fs');
const path = require('path');

function patchGradleFile(gradlePath, replacers, label) {
    if (!fs.existsSync(gradlePath)) {
        console.warn(`Could not find ${label}. It may not be installed.`);
        return;
    }

    let content = fs.readFileSync(gradlePath, 'utf8');
    let patched = false;

    for (const [pattern, replacement] of replacers) {
        if (pattern.test(content)) {
            content = content.replace(pattern, replacement);
            patched = true;
        }
    }

    if (patched) {
        fs.writeFileSync(gradlePath, content, 'utf8');
        console.log(`Successfully patched ${label}`);
    } else {
        console.log(`${label} is already patched.`);
    }
}

const gradlePath = path.resolve(__dirname, '../node_modules/capacitor-native-biometric/android/build.gradle');
patchGradleFile(
    gradlePath,
    [
        [/jcenter\(\)/g, 'mavenCentral()'],
        [/proguard-android\.txt/g, 'proguard-android-optimize.txt'],
        [/(implementation 'androidx\.biometric:biometric:[^']*')/g, "$1\n    implementation 'androidx.activity:activity:1.9.0'"],
    ],
    'capacitor-native-biometric/android/build.gradle'
);

const ttsGradlePath = path.resolve(__dirname, '../node_modules/@capacitor-community/text-to-speech/android/build.gradle');
patchGradleFile(
    ttsGradlePath,
    [
        [/proguard-android\.txt/g, 'proguard-android-optimize.txt'],
    ],
    '@capacitor-community/text-to-speech/android/build.gradle'
);

const filesystemGradlePath = path.resolve(__dirname, '../node_modules/@capacitor/filesystem/android/build.gradle');
patchGradleFile(
    filesystemGradlePath,
    [
        [/apply plugin:\s*['"]kotlin-android['"]\s*\r?\n/g, ''],
        [/\r?\nkotlin\s*\{\s*\r?\n\s*jvmToolchain\(21\)\s*\r?\n\}\s*\r?\n/g, '\n'],
    ],
    '@capacitor/filesystem/android/build.gradle'
);
