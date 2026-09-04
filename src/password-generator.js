(() => {
  function randomInt(max) {
    if (!Number.isSafeInteger(max) || max <= 0 || max > 0x100000000) throw new RangeError("invalid maximum");
    // Rejection sampling avoids modulo bias in generated passwords.
    const limit = Math.floor(0x100000000 / max) * max;
    let value;
    do value = crypto.getRandomValues(new Uint32Array(1))[0];
    while (value >= limit);
    return value % max;
  }

  const pick = (characters) => characters[randomInt(characters.length)];

  function appleStyle() {
    const consonants = "bcdfghjkmnpqrstvwxz";
    const vowels = "aeiouy";
    const groups = [];
    for (let group = 0; group < 3; group++) {
      groups.push([
        pick(consonants), pick(vowels), pick(consonants),
        pick(consonants), pick(vowels), pick(consonants),
      ]);
    }
    const digitSlots = [[0, 5], [1, 0], [1, 5], [2, 0], [2, 5]];
    const [digitGroup, digitPosition] = digitSlots[randomInt(digitSlots.length)];
    groups[digitGroup][digitPosition] = String(randomInt(10));
    let upperGroup;
    let upperPosition;
    do {
      upperGroup = randomInt(3);
      upperPosition = randomInt(6);
    } while (upperGroup === digitGroup && upperPosition === digitPosition);
    groups[upperGroup][upperPosition] = groups[upperGroup][upperPosition].toUpperCase();
    return groups.map((group) => group.join("")).join("-");
  }

  function alphanumeric(length = 15) {
    if (!Number.isSafeInteger(length) || length < 3) throw new RangeError("password length must be at least 3");
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const digits = "0123456789";
    const all = lower + upper + digits;
    const characters = [pick(lower), pick(upper), pick(digits)];
    while (characters.length < length) characters.push(pick(all));
    for (let i = characters.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [characters[i], characters[j]] = [characters[j], characters[i]];
    }
    return characters.join("");
  }

  globalThis.FAPASSWORD_PASSWORDS = Object.freeze({ appleStyle, alphanumeric });
})();
