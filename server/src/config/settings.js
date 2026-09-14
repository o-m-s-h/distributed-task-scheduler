import "dotenv/config";

export const positiveInteger = (name, fallback, maximum = 1000000) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
    return value;
};
