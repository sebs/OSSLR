import { SingleBar, Presets } from 'cli-progress';
import { CopyrightParser } from './Parsers/CopyrightParser';
import { CycloneDXParser } from './Parsers/CycloneDXParser';
import { FileReader } from '../Adapter/Import/FileReader';
import { Downloader } from './Downloader';
import { PackageInfo } from './Model/PackageInfo';
import { PDFFileWriter } from '../Adapter/Export/PDFFileWriter';
import { PDFParser } from './Parsers/PDFParser';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as Logger from '../Logger/Logging';
import { JSONFileWriter } from '../Adapter/Export/JSONFileWriter';
import { JSONParser } from './Parsers/JSONParser';

/**
 * This class is responsible for distributing the different tasks to the responsible classes.
 */
export class LicenseChecker {
  parser!: CycloneDXParser;
  packageInfos!: PackageInfo[];
  bomPath!: string;
  bomData!: string;
  missingValuesPath!: string;
  localDataPath!: string | undefined;
  localData: PackageInfo[] = [];
  noCopyrightList: PackageInfo[] = []; // Packages where the copyright has not been found for
  toBeAppended: PackageInfo[] = []; // Packages that are in the input file but not generated by cdxgen
  fileReader!: FileReader;

  /**
   * Initializes the correct parser for the given BOM format.
   * @param bomFormat Format of the BOM.
   * @param bomPath Path to the BOM file.
   */
  init(bomFormat: string, bomPath: string, localDataPath: string | undefined, missingValues: string): void {
    this.fileReader = new FileReader();
    this.bomPath = bomPath;
    this.missingValuesPath = missingValues;
    this.localDataPath = localDataPath;
    let dataFormat = bomPath.split('.').pop();
    if (!dataFormat) {
      // data format is the file format and currently only json is supported
      Logger.addToLog('Invalid data format', 'Error');
      console.error('Invalid data format');
      process.exit(1);
    }
    switch (bomFormat) {
      // bomformat is the actual format of the bom object, currently only cycloneDX is supported
      case 'cycloneDX':
        this.parser = new CycloneDXParser(dataFormat);
        break;
      default:
        Logger.addToLog( `Unsupported Bom Format ${bomFormat}`, 'Error');
        console.error(
          `Unsupported Bom Format ${bomFormat}!`
        );
        process.exit(1);
    }
  }

  /**
   * Extracts the package information from the BOM file and saves them in a list of PackageInfo objects.
   */
  retrievePackageInfos(): void {
    try {
      this.bomData = this.fileReader.readInput(this.bomPath);
      this.packageInfos = this.parser.parseInput(this.bomData);
    } catch (err) {
      Logger.addToLog('Failed to retrieve Package informations', 'Error');
      console.error('Failed to retrieve Package informations');
      process.exit(1);
    }
  }

 /**
   * Downloads package data, namely the license texts and the readme.
   */
  async downloadPackageData() {
    try {
      let downloader = new Downloader();
      downloader.authenticateGithubClient();
      console.log('Retrieving License Information...');
      // progBar is a progression indicator for better user experience
      const progBar = new SingleBar({}, Presets.shades_classic);
      progBar.start(this.packageInfos.length, 0);
      for (let packageInfo of this.packageInfos) {
        progBar.increment();
        for (let url of packageInfo.externalReferences) {
          let [license, readme] = ['',''];
          let {remaining, reset} = await downloader.getRemainingRateObj();
          // Checks how many request are still availabe to make to GitHub
          if(remaining >= 1){
            [license, readme] = await downloader.downloadLicenseAndREADME(url);
          } else {
            // Timer for how long should wait before continuing, difference between time now and the reset time + 10 seconds buffer time
            let waitTime = Math.abs(reset*1000 - Date.now()) + 10000;
            console.warn('GitHub Request limit reached. Waiting for ' + waitTime + 'ms.');
            Logger.addToLog('GitHub Request limit reached. Waiting for ' + waitTime + 'ms.', 'Warning');
            await new Promise(r => setTimeout(r, waitTime));
            [license, readme] = await downloader.downloadLicenseAndREADME(url);
          }
          if (license != '') {
            packageInfo.licenseTexts.push(license);
          }
          packageInfo.readme = readme;
        }
      }
      progBar.stop();
      console.log('Done!');
    } catch (err) {
      Logger.addToLog('Failed to download package data', 'Error');
      console.error('Failed to download package data');
      process.exit(1);
    }
  }

  /**
   * Coordinates the parsing of the downloaded license files.
   */
  parseCopyright(): void {
    let copyrightParser = new CopyrightParser();
    for (let i = 0; i < this.packageInfos.length; i++) {
      let licenseTexts = this.packageInfos[i].licenseTexts; // readability
      for (let j = 0; j < licenseTexts.length; j++) {
        let copyright = copyrightParser.extractCopyright(licenseTexts[j]);
        // if the last license does not contain the copyright check the README
        if (j == licenseTexts.length - 1 && copyright === '') {
          copyright = copyrightParser.extractCopyright(
            this.packageInfos[i].readme
          );
        }
        if (copyright === '') {
          continue;
        }
        copyright = copyrightParser.removeOverheadFromCopyright(copyright);
        this.packageInfos[i].copyright = copyright;
      }
    }
  }
  
   /**
   * Extracts the package information from the file with default values and saves them in a list of PackageInfo objects.
   */
  retrieveLocalData(): void{
    if (!this.localDataPath) return;
    if (!existsSync(this.localDataPath)) {
      console.warn('Invalid local file path to default values');
      Logger.addToLog('Invalid local file path to default values', 'Warning');
      return;
    }
    const temp = this.fileReader.readInput(this.localDataPath);
    this.localData= this.parser.parseInput(temp);
  }

  /**
   * Combines the information that has been retrieves thorugh external references and the ones given by the user.
   */
  combine(): void {
    let local: PackageInfo[] = this.localData;
    let generated: PackageInfo[] = this.packageInfos;
    for (let i = 0; i < local.length; i++) {
      let localDataAdded = false; // change name
      for (let j = 0; j < generated.length; j++) {
        if (
          generated[j].samePackage(local[i]) && generated[j].isVersionInRangeOf(local[i])
        ) {
          generated[j].licenses = local[i].licenses;
          generated[j].copyright = local[i].copyright;
          localDataAdded = true;
          // Packages of the same name and group but with different versions 
        } else if (generated[j].samePackage(local[i])) {
          localDataAdded = true;
          this.toBeAppended.push(local[i]);
          console.warn('Version of package did not match in the given local file: ' + local[i].toString() + ' and the generated file by cdxegen: ' + generated[j].toString() + ' possible duplicate created.');
          Logger.addToLog('Version of package did not match in the given local file: ' + local[i].toString() + ' and the generated file by cdxegen: ' + generated[j].toString() + ' possible duplicate created.', 'Warning');
        }
      }
      if (!localDataAdded) {
        this.toBeAppended.push(local[i]);
      }
    }
  }

  createOutputDir(){
      try {
        if (!existsSync(path.join('out'))) {
          mkdirSync(path.join('out'));
        }
      } catch (err) {
        console.error(err);
        Logger.addToLog('Failed to create the out directory', 'Error');
        console.error('Failed to create the out directory');
        process.exit(1);
      }
  }

  /**
   * Exports updatedBom.json file and the file tracking packages with missing license/copyright
   */
  exportJSON(): void {
    let jsonParser = new JSONParser();
    let jsonFileWriter = new JSONFileWriter();
    try {
      // Adding copyrights to packages
      let resultBom = JSON.parse(this.bomData);
      resultBom = jsonParser.insertCopyrightIntoBom(
        this.packageInfos,
        resultBom
      );
      // Adding entries which are in the input file but missing in the generated file
      resultBom = jsonParser.addMissingEntries(this.toBeAppended, resultBom);

      // this.packageInfos.filter()
      this.packageInfos.forEach((packageInfo) => {
        if (packageInfo.copyright === '') {
          console.warn('Failed to collect the necessary information for ' + packageInfo.toString());
          Logger.addToLog('Failed to collect the necessary information for ' + packageInfo.toString(), 'Warning');
          this.noCopyrightList.push(packageInfo);
        }
      });
      

      // Parse packageInfo into a array of Json objects
      let resultMissingValues = jsonParser.parsePkgInfo(
        this.noCopyrightList
      );
      // Strigify results so that they can be written
      const stringBom = JSON.stringify(resultBom, null, 4);
      const stringMissingValues = JSON.stringify(resultMissingValues, null, 4);

      let newFile = path.join('out', 'updatedBom.json');
      jsonFileWriter.write(newFile, stringBom);
      jsonFileWriter.write(this.missingValuesPath, stringMissingValues);

    } catch (err) {
      Logger.addToLog('Failed to export output into a json file', 'Error');
      console.error('Failed to export output into a json file');
      process.exit(1);
    }
  }

  /**
   * Exports updatedBom.pdf file
   */
  exportPDF(): void {
    try {
      let pdfParser = new PDFParser();
      let pdfExporter = new PDFFileWriter();
      // Concat the missing values for pdf export 
      this.packageInfos = this.packageInfos.concat(this.toBeAppended);
      let [head, body] = pdfParser.parse(this.packageInfos);
      pdfExporter.export(head, body);
    } catch (err) {
      Logger.addToLog('Failed to export output into a pdf file', 'Error');
      console.error('Failed to export output into a pdf file');
      process.exit(1);
    }
  }

  /**
   * Checks whether the bom contains license information for the given package.
   * @param {PackageInfo} packageInfo Entry from bom.json containing information for one package.
   * @returns {boolean} Whether the packageInfo contains a license.
   */
  hasLicense(packageInfo: PackageInfo): boolean {
    return (
      Array.isArray(packageInfo['licenses']) &&
      packageInfo['licenses'].length > 0
    );
  }

  /**
   * Checks whether the bom contains external references for the given package.
   * @param {object} packageInfo Entry from bom.json containing information for one package.
   * @returns {boolean} Whether the packageInfo contains external references.
   */
  hasExternalRefs(packageInfo: PackageInfo): boolean {
    return (
      Array.isArray(packageInfo['externalReferences']) &&
      packageInfo['externalReferences'].length > 0
    );
  }
}
